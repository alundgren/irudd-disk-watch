import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  ScanSequence,
  MAX_DIAGNOSTIC_BYTES,
  MAX_FRAME_BYTES,
  object,
  nativeIdentity,
  workerInfo,
  count,
  type ScanLine,
} from '../shared/workerProtocol.ts'
import { workerFrames, workerOperation, WorkerRequestNotSent, type WorkerConnection } from './worker.ts'
import { containsPath, pathKey } from '../shared/paths.ts'
import type {
  DeleteFailure,
  DeleteResult,
  LockProcess,
  NodeKind,
  NativeIdentity,
  DeleteOperationState,
  ScanMethod,
  ScanStatus,
  StagedDelete,
} from '../shared/types'
import type { Store } from './store'

type ScannerTimes = { createdAt?: number | null; lastWrittenAt?: number | null; identity?: NativeIdentity }
type ScannerLine = ScanLine

export interface ScanOptions {
  store: Store
  scannerExe: string
  stateDir?: string
  diskId: number
  minFileSize: number
  method?: Exclude<ScanMethod, 'incremental'>
  incremental?: boolean
  onProgress(progress: DiskProgress): void
  signal: AbortSignal
}

export interface ScanOutcome {
  scanId: number
  status: Exclude<ScanStatus, 'running'>
  message?: string
}

export type DiskProgress =
  { phase: 'reading'; files: number; dirs: number; bytes: number } | { phase: 'saving'; rows: number }

const SAVE_PROGRESS_EVERY = 25_000

class ScanCancelled extends Error {}

/** Writes one scanner run into the store. The scan's rows commit together or not at all. */
class Ingest {
  private readonly scannerToNode = new Map<number, number>()
  private readonly childIndex = new Map<number, Map<string, number>>()
  private readonly selectChildren
  private readonly insertNode
  private readonly insertEntry
  private readonly insertError
  rows = 0

  private readonly store: Store
  private readonly scanId: number
  private readonly rootNode: number
  private readonly native: boolean
  /** Whether this worker reports read errors per directory. Known once the root arrives. */
  private errorsByDirectory = false

  constructor(store: Store, scanId: number, rootNode: number, native = false) {
    this.native = native
    this.store = store
    this.scanId = scanId
    this.rootNode = rootNode
    const { db } = store
    this.selectChildren = db.prepare(`SELECT id, kind, name, name_bytes FROM node WHERE parent = ?`)
    this.insertNode = db.prepare(
      `INSERT INTO node (parent, name, kind, name_bytes, identity_key) VALUES (?, ?, ?, ?, ?)`,
    )
    this.insertEntry = db.prepare(
      native
        ? `INSERT INTO entry (scan_id, node_id, size, files, created_at, last_written_at, native_identity, subtree_errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO entry (scan_id, node_id, size, files, created_at, last_written_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.insertError = db.prepare(`INSERT INTO scan_error (scan_id, path, message) VALUES (?, ?, ?)`)
  }

  private intern(parent: number, kind: NodeKind, name: string, nameBytes?: string): number {
    let index = this.childIndex.get(parent)
    if (!index) {
      index = new Map()
      for (const row of this.selectChildren.all(parent) as {
        id: number
        kind: NodeKind
        name: string
        name_bytes: string | null
      }[]) {
        index.set(
          `${row.kind}:${this.native && row.kind !== 'rest' ? 'u:' + row.name_bytes : 'w:' + row.name.toLowerCase()}`,
          row.id,
        )
      }
      this.childIndex.set(parent, index)
    }
    const identityKey = this.native && kind !== 'rest' ? 'u:' + nameBytes : 'w:' + name.toLowerCase()
    const key = `${kind}:${identityKey}`
    let id = index.get(key)
    if (id === undefined) {
      id = Number(this.insertNode.run(parent, name, kind, nameBytes ?? null, identityKey).lastInsertRowid)
      index.set(key, id)
    }
    return id
  }

  private parentNode(scannerId: number): number {
    const node = this.scannerToNode.get(scannerId)
    if (node === undefined) throw new Error(`Scanner sent a child before its parent dir ${scannerId}`)
    return node
  }

  private entry(
    nodeId: number,
    size: number,
    files: number,
    times: ScannerTimes = {},
    errors: number | null = null,
  ): void {
    const values = [this.scanId, nodeId, size, files, times.createdAt ?? null, times.lastWrittenAt ?? null]
    if (this.native) this.insertEntry.run(...values, times.identity ? JSON.stringify(times.identity) : null, errors)
    else this.insertEntry.run(...values)
    this.rows++
  }

  handle(line: Exclude<ScannerLine, { t: 'progress' } | { t: 'done' }>): void {
    switch (line.t) {
      case 'root':
        this.store.setScanRoot(this.scanId, line.root)
        return
      case 'dir': {
        const node =
          line.parent === null
            ? this.rootNode
            : this.intern(this.parentNode(line.parent), 'dir', line.name, line.nameBytes)
        this.scannerToNode.set(line.id, node)
        if (line.parent === null) this.errorsByDirectory = line.errors !== undefined
        this.entry(node, line.size, line.files, line, line.errors ?? null)
        return
      }
      case 'file':
        // A captured file was read in full, so nothing unreadable lies at or under it.
        this.entry(
          this.intern(this.parentNode(line.parent), 'file', line.name, line.nameBytes),
          line.size,
          1,
          line,
          this.errorsByDirectory ? 0 : null,
        )
        return
      case 'rest':
        this.entry(this.intern(this.parentNode(line.parent), 'rest', ''), line.size, line.files)
        return
      case 'error':
        this.insertError.run(this.scanId, line.path, line.message)
        return
    }
  }

  finish(done: Extract<ScannerLine, { t: 'done' }>): void {
    const { diskId } = this.store.db.prepare('SELECT disk_id AS diskId FROM scan WHERE id = ?').get(this.scanId) as {
      diskId: number
    }
    const eligible = this.store.hideSettings(diskId).metadataEligible
    this.store.db
      .prepare(
        `UPDATE scan SET status = 'complete', finished_at = ?, size = ?, files = ?, dirs = ?, errors = ?,
           duration_ms = ?, method = ?, fallback = ?, coverage = ?, policy = ?, skipped = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        done.size,
        done.files,
        done.dirs,
        done.errors,
        done.ms,
        done.method,
        done.fallback,
        done.coverage ?? (done.errors ? 'partial' : 'complete'),
        done.policy ?? null,
        done.skipped ? JSON.stringify(done.skipped) : null,
        this.scanId,
      )
    if (eligible !== this.store.hideSettings(diskId).metadataEligible) {
      this.store.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
    }
  }
}

export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  if (options.store.getDisk(options.diskId).targetOS !== 'windows') return runNativeScan(options)
  const { store, diskId, signal } = options
  const disk = store.getDisk(diskId)
  const excludes = store.excludes(diskId)
  const scanId = store.beginScan(diskId, excludes)

  if (signal.aborted) {
    store.endScan(scanId, 'cancelled', 'Cancelled')
    return { scanId, status: 'cancelled', message: 'Cancelled' }
  }

  const args = [disk.root, '--min-file-size', String(options.minFileSize)]
  if (options.method) args.push('--method', options.method)
  for (const path of excludes) args.push('--exclude', path)
  const child = spawn(options.scannerExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const onAbort = () => child.kill()
  signal.addEventListener('abort', onAbort)
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, MAX_DIAGNOSTIC_BYTES)
  })
  const exited = new Promise<{ code: number | null } | { error: Error }>((resolve) => {
    child.once('error', (error) => resolve({ error }))
    child.once('close', (code) => resolve({ code }))
  })

  const ingest = new Ingest(store, scanId, disk.rootNode)
  let inTransaction = false
  let done: Extract<ScannerLine, { t: 'done' }> | undefined
  try {
    for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const line = JSON.parse(text) as ScannerLine
      if (line.t === 'progress') {
        options.onProgress({ phase: 'reading', files: line.files, dirs: line.dirs, bytes: line.bytes })
        continue
      }
      if (line.t === 'done') {
        done = line
        continue
      }
      if (!inTransaction) {
        store.db.exec('BEGIN')
        inTransaction = true
      }
      ingest.handle(line)
      if (ingest.rows % SAVE_PROGRESS_EVERY === 0) options.onProgress({ phase: 'saving', rows: ingest.rows })
    }
    const exit = await exited
    if (signal.aborted) throw new ScanCancelled()
    if ('error' in exit) throw exit.error
    if (exit.code !== 0 || !done) throw new Error(stderr.trim() || `Scanner exited with code ${exit.code}`)
    if (!inTransaction) store.db.exec('BEGIN')
    ingest.finish(done)
    store.db.exec('COMMIT')
    return { scanId, status: 'complete' }
  } catch (err) {
    if (store.db.isTransaction) store.db.exec('ROLLBACK')
    child.kill()
    const cancelled = err instanceof ScanCancelled || signal.aborted
    const status = cancelled ? 'cancelled' : 'failed'
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    store.endScan(scanId, status, message)
    return { scanId, status, message }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
  }
}

async function runNativeScan(options: ScanOptions): Promise<ScanOutcome> {
  const { store, diskId, signal } = options
  const disk = store.getDisk(diskId)
  const scanId = store.beginScan(diskId, store.excludes(diskId))
  const ingest = new Ingest(store, scanId, disk.rootNode, true)
  const sequence = new ScanSequence(true)
  let done: Extract<ScanLine, { t: 'done' }> | undefined
  try {
    if (!disk.nativeRoot) throw new Error('Inspect this native root before scanning.')
    const rules = store.excludeRules(diskId)
    if (rules.some((rule) => !rule.components)) throw new Error('Resolve native exclusions before scanning.')
    const connection = { machine: disk.machine, scannerExe: options.scannerExe, stateDir: options.stateDir }
    for await (const line of workerFrames(
      connection,
      'scan',
      {
        root: disk.nativeRoot,
        excludes: rules.map((rule) => rule.components),
        minFileSize: options.minFileSize,
        ...(options.incremental && disk.machine.kind === 'local' && disk.machine.os === 'macos'
          ? { incremental: true }
          : {}),
      },
      signal,
    )) {
      if (line.t === 'result' || line.t === 'fatal') throw new Error('Unexpected native scan response.')
      sequence.accept(line)
      if (line.t === 'progress') {
        options.onProgress({ phase: 'reading', ...line })
        continue
      }
      if (line.t === 'done') {
        done = line
        continue
      }
      if (!store.db.isTransaction) store.db.exec('BEGIN')
      ingest.handle(line)
      if (ingest.rows && ingest.rows % SAVE_PROGRESS_EVERY === 0)
        options.onProgress({ phase: 'saving', rows: ingest.rows })
    }
    if (!done || !sequence.done || signal.aborted)
      throw new Error(signal.aborted ? 'Cancelled' : 'Incomplete native scan.')
    if (!store.db.isTransaction) store.db.exec('BEGIN')
    ingest.finish(done)
    store.db.exec('COMMIT')
    return { scanId, status: 'complete' }
  } catch (error) {
    if (store.db.isTransaction) store.db.exec('ROLLBACK')
    const status = signal.aborted ? 'cancelled' : 'failed'
    const message = error instanceof Error ? error.message : String(error)
    store.endScan(scanId, status, message)
    return { scanId, status, message }
  }
}

function sameIdentity(a: NativeIdentity | undefined, b: NativeIdentity | undefined): boolean {
  return !!a && !!b && a.device === b.device && a.inode === b.inode && a.mount === b.mount
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function validateReceipt(value: unknown, payload: Record<string, unknown>, connection: WorkerConnection): DeleteResult {
  const operationId = String(payload.operationId)
  const targets = payload.targets as StagedDelete[]
  const receipt = object(value)
  if (
    receipt.operationId !== operationId ||
    !['running', 'completed', 'interrupted', 'unknown'].includes(String(receipt.state)) ||
    !Array.isArray(receipt.deleted) ||
    !Array.isArray(receipt.failed)
  )
    throw new Error('Invalid native deletion receipt. The outcome remains uncertain.')
  if (receipt.state !== 'unknown' || receipt.digest !== undefined) {
    const worker = workerInfo(receipt.worker)
    if (
      worker.id !== connection.machine.workerId ||
      worker.account !== connection.machine.account ||
      worker.os !== connection.machine.os ||
      canonicalJson(receipt.root) !== canonicalJson(payload.root)
    )
      throw new Error('Deletion receipt belongs to a different worker or root.')
    const digest = createHash('sha256')
      .update(canonicalJson({ operationId, root: payload.root, targets: payload.targets, worker }))
      .digest('hex')
    if (receipt.digest !== digest) throw new Error('Deletion receipt request digest does not match.')
    count(receipt.startedAt, 'deletion start')
    if (receipt.state === 'completed') count(receipt.finishedAt, 'deletion finish')
  } else if (receipt.deleted.length || receipt.failed.length)
    throw new Error('Unknown deletion receipt cannot claim outcomes.')
  const requested = new Set(targets.map((target) => target.path))
  const seen = new Set<string>()
  const check = (path: unknown) => {
    if (typeof path !== 'string' || !requested.has(path) || seen.has(path))
      throw new Error('Deletion receipt does not match the requested targets.')
    seen.add(path)
    return path
  }
  const deleted = receipt.deleted.map(check)
  const failed: DeleteFailure[] = receipt.failed.map((value: unknown) => {
    const row = object(value)
    const path = check(row.path)
    if (
      typeof row.message !== 'string' ||
      typeof row.failedPath !== 'string' ||
      row.errorDomain !== 'posix' ||
      !(row.errorCode === null || Number.isSafeInteger(row.errorCode))
    )
      throw new Error('Invalid native deletion failure.')
    return {
      path,
      failedPath: row.failedPath,
      message: row.message,
      errorCode: row.errorCode as number | null,
      errorDomain: 'posix',
      lockInfo: {
        status: 'unavailable',
        processes: [],
        note: 'Native process lookup is unavailable. Open Unix files may remain allocated after successful unlink.',
      },
    }
  })
  if (receipt.state === 'completed' && seen.size !== requested.size)
    throw new Error('Completed deletion receipt omits selected targets.')
  if (receipt.state !== 'completed')
    for (const target of targets)
      if (!seen.has(target.path))
        failed.push({
          path: target.path,
          message:
            'Deletion outcome is uncertain. Check status, then scan again and deliberately restage unresolved items.',
          errorDomain: 'posix',
        })
  return { operationId, state: receipt.state as DeleteOperationState, deleted, failed }
}

export async function executeNativeDelete(
  store: Store,
  connection: WorkerConnection,
  diskId: number,
  targets: StagedDelete[],
): Promise<DeleteResult> {
  const disk = store.getDisk(diskId)
  if (!disk.cleanupEnabled || !disk.nativeRoot)
    throw new Error('Enable cleanup for this quiescent root in Settings first.')
  if (!targets.length || targets.length > 1000) throw new Error('Select between 1 and 1,000 deletion targets.')
  const checked = targets.map((target) => {
    const fresh = store.stageDelete(diskId, target.nodeId)
    if (
      fresh.scanId !== target.scanId ||
      fresh.diskId !== target.diskId ||
      fresh.machineId !== target.machineId ||
      fresh.kind !== target.kind ||
      fresh.path !== target.path ||
      fresh.size !== target.size ||
      fresh.files !== target.files ||
      JSON.stringify(fresh.components) !== JSON.stringify(target.components) ||
      !sameIdentity(fresh.identity, target.identity) ||
      !sameIdentity(fresh.rootIdentity, target.rootIdentity)
    )
      throw new Error('The native selection changed. Scan and stage it again.')
    nativeIdentity(fresh.identity)
    return fresh
  })
  const latest = store.latestCompleteScan(diskId)!
  if (
    store
      .listDeleteOperations(diskId)
      .some((operation) => operation.state !== 'completed' && operation.createdAt >= latest.startedAt)
  )
    throw new Error('Check the previous deletion status and scan again before staging a new request.')
  const unique = [...new Map(checked.map((target) => [JSON.stringify(target.components), target])).values()]
  const top = unique.filter(
    (target) =>
      !unique.some(
        (other) =>
          other !== target &&
          other.components!.length < target.components!.length &&
          other.components!.every((part, at) => target.components![at] === part),
      ),
  )
  const operationId = randomUUID()
  const payload = {
    operationId,
    root: top[0]!.rootObservation,
    targets: top.map(({ path, components, kind, identity }) => ({ path, components, kind, identity })),
  }
  store.recordDeleteOperation({ operationId, diskId, payload, state: 'pending' })
  try {
    store.updateDeleteOperation(operationId, 'running')
    const receipt = await workerOperation(connection, 'delete', payload, undefined, () => {
      store.requireFreshDeleteScan(diskId, latest.id)
    })
    const result = validateReceipt(receipt, payload, connection)
    store.updateDeleteOperation(operationId, result.state!, receipt)
    return { ...result, machineName: disk.machine.name }
  } catch (error) {
    // The worker never saw the request, so there is no outcome to check later.
    if (error instanceof WorkerRequestNotSent) {
      store.discardUnsentDeleteOperation(operationId)
      throw new Error(error.message)
    }
    store.updateDeleteOperation(operationId, 'unknown')
    throw new Error(
      `Deletion ${operationId} has an uncertain outcome. Check status before any new action. ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function recoverNativeDelete(
  store: Store,
  connection: WorkerConnection,
  operationId: string,
): Promise<DeleteResult> {
  const operation = store.getDeleteOperation(operationId)
  const payload = object(operation.payload)
  const receipt = await workerOperation(connection, 'deleteStatus', { operationId })
  const result = validateReceipt(receipt, payload, connection)
  store.updateDeleteOperation(operationId, result.state!, receipt)
  return { ...result, machineName: store.getDisk(operation.diskId).machine.name }
}

export async function executeDelete(
  store: Store,
  scannerExe: string,
  diskId: number,
  targets: StagedDelete[],
): Promise<DeleteResult> {
  if (store.getDisk(diskId).targetOS !== 'windows')
    throw new Error('Use the identity-bound native cleanup connection for this root.')
  if (targets.length > 1000) throw new Error('Select at most 1,000 deletion targets.')
  const { root } = store.getDisk(diskId)
  store.requireFreshDeleteScan(diskId)
  const checked = targets.map((target) => {
    const latest = store.stageDelete(diskId, target.nodeId)
    if (
      latest.scanId !== target.scanId ||
      (target.diskId !== undefined && target.diskId !== diskId) ||
      latest.kind !== target.kind ||
      pathKey(latest.path) !== pathKey(target.path) ||
      latest.size !== target.size ||
      latest.files !== target.files
    )
      throw new Error('The queued item changed. Remove it and stage it again from the latest scan.')
    return latest
  })
  const normalized = [...new Map(checked.map((target) => [pathKey(target.path), target])).values()]
  const top = normalized.filter(
    (target) =>
      !normalized.some(
        (other) => pathKey(other.path) !== pathKey(target.path) && containsPath(other.path, target.path),
      ),
  )
  if (!top.length) return { deleted: [], failed: [] }

  return new Promise<DeleteResult>((resolve, reject) => {
    const child = spawn(scannerExe, ['--delete', '--root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (Buffer.byteLength(stdout) > MAX_FRAME_BYTES) {
        child.kill()
        reject(new Error('Deletion result exceeds its size limit.'))
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, MAX_DIAGNOSTIC_BYTES)
    })
    child.stdin.on('error', () => {})
    try {
      store.requireFreshDeleteScan(diskId, checked[0]!.scanId)
      child.stdin.end(JSON.stringify(top.map(({ path, kind }) => ({ path, kind }))))
    } catch (error) {
      child.stdin.end()
      child.kill()
      reject(error)
    }
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        const value: unknown = JSON.parse(stdout.trim())
        if (
          !value ||
          typeof value !== 'object' ||
          !('deleted' in value) ||
          !('failed' in value) ||
          !Array.isArray(value.deleted) ||
          !Array.isArray(value.failed)
        )
          throw new Error('Invalid deletion result.')
        const requested = new Set(top.map((target) => pathKey(target.path)))
        const check = (path: unknown) => {
          if (typeof path !== 'string' || !requested.delete(pathKey(path)))
            throw new Error('Deletion result does not match the queued paths.')
          return path
        }
        const deleted = value.deleted.map(check)
        const failed = value.failed.map((row: unknown) => {
          if (
            !row ||
            typeof row !== 'object' ||
            !('path' in row) ||
            !('message' in row) ||
            typeof row.message !== 'string'
          )
            throw new Error('Invalid deletion failure.')
          const failure: DeleteFailure = { path: check(row.path), message: row.message }
          if ('failedPath' in row) {
            if (
              typeof row.failedPath !== 'string' ||
              !(containsPath(failure.path, row.failedPath) || containsPath(row.failedPath, failure.path))
            )
              throw new Error('Invalid failed operation path.')
            failure.failedPath = row.failedPath
          }
          if ('errorCode' in row) {
            if (
              row.errorCode !== null &&
              !(
                typeof row.errorCode === 'number' &&
                Number.isInteger(row.errorCode) &&
                row.errorCode >= 0 &&
                row.errorCode <= 0xffffffff
              )
            )
              throw new Error('Invalid Windows error code.')
            failure.errorCode = row.errorCode as number | null
          }
          if ('lockInfo' in row) {
            const info = row.lockInfo
            if (
              !info ||
              typeof info !== 'object' ||
              !('status' in info) ||
              !('processes' in info) ||
              !('note' in info) ||
              typeof info.note !== 'string' ||
              typeof info.status !== 'string' ||
              !['found', 'none', 'unavailable', 'not_checked'].includes(info.status) ||
              !Array.isArray(info.processes) ||
              (info.status === 'found') !== info.processes.length > 0
            )
              throw new Error('Invalid lock lookup result.')
            const pids = new Set<number>()
            const processes: LockProcess[] = info.processes.map((process: unknown) => {
              if (
                !process ||
                typeof process !== 'object' ||
                !('pid' in process) ||
                typeof process.pid !== 'number' ||
                !Number.isInteger(process.pid) ||
                process.pid <= 0 ||
                process.pid > 0xffffffff ||
                pids.has(process.pid) ||
                !('source' in process) ||
                typeof process.source !== 'string' ||
                !['restart_manager', 'open_handle'].includes(process.source)
              )
                throw new Error('Invalid lock process.')
              for (const key of ['processName', 'programName', 'executablePath', 'serviceName', 'note'] as const) {
                const value = (process as Record<string, unknown>)[key]
                if (value !== null && typeof value !== 'string') throw new Error('Invalid lock process metadata.')
              }
              pids.add(process.pid)
              return process as LockProcess
            })
            failure.lockInfo = {
              status: info.status as NonNullable<DeleteFailure['lockInfo']>['status'],
              processes,
              note: info.note,
            }
          }
          return failure
        })
        if (requested.size || code !== (failed.length ? 1 : 0))
          throw new Error(`Delete exited with code ${code} without a complete result.`)
        resolve({ deleted, failed })
      } catch (error) {
        reject(new Error(stderr.trim() || (error instanceof Error ? error.message : `Delete exited with code ${code}`)))
      }
    })
  })
}
