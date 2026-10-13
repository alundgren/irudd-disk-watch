import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { NodeKind, ScanProgress, ScanStatus } from '../shared/types'
import type { Store } from './store'

/** One NDJSON line printed by dw-scan. Tree lines arrive in pre-order. */
type ScannerLine =
  | { t: 'progress'; files: number; dirs: number; bytes: number }
  | { t: 'dir'; id: number; parent: number | null; name: string; size: number; files: number }
  | { t: 'file'; parent: number; name: string; size: number }
  | { t: 'rest'; parent: number; size: number; files: number }
  | { t: 'error'; path: string; message: string }
  | { t: 'done'; size: number; files: number; dirs: number; errors: number; ms: number }

export interface ScanOptions {
  store: Store
  scannerExe: string
  diskId: number
  minFileSize: number
  onProgress(progress: ScanProgress): void
  signal: AbortSignal
}

export interface ScanOutcome {
  scanId: number
  status: Exclude<ScanStatus, 'running'>
  message?: string
}

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
    this.store.db
      .prepare(
        `UPDATE scan SET status = 'complete', finished_at = ?, size = ?, files = ?, dirs = ?, errors = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(Date.now(), done.size, done.files, done.dirs, done.errors, done.ms, this.scanId)
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
        options.onProgress({ phase: 'walking', diskId, files: line.files, dirs: line.dirs, bytes: line.bytes })
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
      if (ingest.rows % SAVE_PROGRESS_EVERY === 0) options.onProgress({ phase: 'saving', diskId, rows: ingest.rows })
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
