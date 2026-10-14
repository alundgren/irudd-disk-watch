import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { containsPath, pathKey } from '../shared/paths.ts'
import type { DeleteResult, NodeKind, ScanMethod, ScanStatus, StagedDelete } from '../shared/types'
import type { Store } from './store'

/** One NDJSON line printed by dw-scan. Tree lines arrive in pre-order. */
type ScannerLine =
  | { t: 'progress'; files: number; dirs: number; bytes: number }
  | { t: 'dir'; id: number; parent: number | null; name: string; size: number; files: number }
  | { t: 'file'; parent: number; name: string; size: number }
  | { t: 'rest'; parent: number; size: number; files: number }
  | { t: 'error'; path: string; message: string }
  | {
      t: 'done'
      size: number
      files: number
      dirs: number
      errors: number
      ms: number
      method: ScanMethod
      fallback: string | null
    }

export interface ScanOptions {
  store: Store
  scannerExe: string
  diskId: number
  minFileSize: number
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

  constructor(store: Store, scanId: number, rootNode: number) {
    this.store = store
    this.scanId = scanId
    this.rootNode = rootNode
    const { db } = store
    this.selectChildren = db.prepare(`SELECT id, kind, name FROM node WHERE parent = ?`)
    this.insertNode = db.prepare(`INSERT INTO node (parent, name, kind) VALUES (?, ?, ?)`)
    this.insertEntry = db.prepare(`INSERT INTO entry (scan_id, node_id, size, files) VALUES (?, ?, ?, ?)`)
    this.insertError = db.prepare(`INSERT INTO scan_error (scan_id, path, message) VALUES (?, ?, ?)`)
  }

  private intern(parent: number, kind: NodeKind, name: string): number {
    let index = this.childIndex.get(parent)
    if (!index) {
      index = new Map()
      for (const row of this.selectChildren.all(parent) as { id: number; kind: NodeKind; name: string }[]) {
        index.set(`${row.kind}:${row.name.toLowerCase()}`, row.id)
      }
      this.childIndex.set(parent, index)
    }
    const key = `${kind}:${name.toLowerCase()}`
    let id = index.get(key)
    if (id === undefined) {
      id = Number(this.insertNode.run(parent, name, kind).lastInsertRowid)
      index.set(key, id)
    }
    return id
  }

  private parentNode(scannerId: number): number {
    const node = this.scannerToNode.get(scannerId)
    if (node === undefined) throw new Error(`Scanner sent a child before its parent dir ${scannerId}`)
    return node
  }

  private entry(nodeId: number, size: number, files: number): void {
    this.insertEntry.run(this.scanId, nodeId, size, files)
    this.rows++
  }

  handle(line: Exclude<ScannerLine, { t: 'progress' } | { t: 'done' }>): void {
    switch (line.t) {
      case 'dir': {
        const node = line.parent === null ? this.rootNode : this.intern(this.parentNode(line.parent), 'dir', line.name)
        this.scannerToNode.set(line.id, node)
        this.entry(node, line.size, line.files)
        return
      }
      case 'file':
        this.entry(this.intern(this.parentNode(line.parent), 'file', line.name), line.size, 1)
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
           duration_ms = ?, method = ?, fallback = ?
         WHERE id = ?`,
      )
      .run(Date.now(), done.size, done.files, done.dirs, done.errors, done.ms, done.method, done.fallback, this.scanId)
    if (eligible !== this.store.hideSettings(diskId).metadataEligible) {
      this.store.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
    }
  }
}

export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const { store, diskId, signal } = options
  const disk = store.getDisk(diskId)
  const excludes = store.excludes(diskId)
  const scanId = store.beginScan(diskId, excludes)

  const args = [disk.root, '--min-file-size', String(options.minFileSize)]
  for (const path of excludes) args.push('--exclude', path)
  const child = spawn(options.scannerExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const onAbort = () => child.kill()
  signal.addEventListener('abort', onAbort)
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
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
  }
}

export async function executeDelete(
  store: Store,
  scannerExe: string,
  diskId: number,
  targets: StagedDelete[],
): Promise<DeleteResult> {
  const { root } = store.getDisk(diskId)
  const checked = targets.map((target) => {
    const latest = store.stageDelete(diskId, target.nodeId)
    if (
      latest.scanId !== target.scanId ||
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
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(top.map(({ path, kind }) => ({ path, kind }))))
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
          return { path: check(row.path), message: row.message }
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
