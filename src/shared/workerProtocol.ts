import { unixLabel } from './paths.ts'
import type { NativeIdentity, NativeRoot, WorkerInfo } from './types'

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024

export type ScanLine =
  | { t: 'progress'; files: number; dirs: number; bytes: number }
  | { t: 'root'; root: NativeRoot }
  | {
      t: 'dir'
      id: number
      parent: number | null
      name: string
      nameBytes?: string
      identity?: NativeIdentity
      size: number
      files: number
      /** Read errors at or under this directory. Older Unix workers omit it. */
      errors?: number
      createdAt: number | null
      lastWrittenAt: number | null
    }
  | {
      t: 'file'
      parent: number
      name: string
      nameBytes?: string
      identity?: NativeIdentity
      size: number
      createdAt: number | null
      lastWrittenAt: number | null
    }
  | { t: 'rest'; parent: number; size: number; files: number }
  | { t: 'error'; path: string; message: string }
  | {
      t: 'done'
      size: number
      files: number
      dirs: number
      errors: number
      ms: number
      method: 'walk' | 'mft' | 'incremental'
      fallback: string | null
      coverage?: 'complete' | 'partial'
      policy?: string
      skipped?: { symlinks: number; special: number; mounts: number }
    }

export type WorkerFrame =
  | ScanLine
  | { t: 'hello'; v: 1; requestId: string; worker: WorkerInfo }
  | { t: 'result'; value: unknown }
  | { t: 'fatal'; message: string }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Worker sent a non-object record.')
  return value as Record<string, unknown>
}

export function textField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_FRAME_BYTES) throw new Error(`Invalid worker ${field}.`)
  return value
}

export function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid worker ${field}.`)
  return value
}

function timestamp(value: unknown): number | null {
  return value === null ? null : count(value, 'timestamp')
}

export function bytes(value: unknown, component = false): string {
  const encoded = textField(value, 'encoded path')
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded || decoded.includes(0)) throw new Error('Invalid encoded native path.')
  if (
    component &&
    (!decoded.length || decoded.includes(47) || decoded.equals(Buffer.from('.')) || decoded.equals(Buffer.from('..')))
  )
    throw new Error('Invalid native path component.')
  return encoded
}

export function nativeIdentity(value: unknown): NativeIdentity {
  const row = object(value)
  for (const field of ['device', 'inode', ...(row.mount === undefined ? [] : ['mount'])])
    if (typeof row[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row[field] as string))
      throw new Error(`Invalid native ${field} identity.`)
  return row as unknown as NativeIdentity
}

export function nativeRoot(value: unknown): NativeRoot {
  const row = object(value)
  textField(row.path, 'root path')
  const raw = Buffer.from(bytes(row.pathBytes), 'base64')
  if (!raw.length || raw[0] !== 47) {
    // Windows inspection has a native absolute drive/UNC path instead.
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(String(row.path))) throw new Error('Worker root is not absolute.')
  }
  nativeIdentity(row.identity)
  textField(row.filesystem, 'filesystem')
  count(row.observedAt, 'observation time')
  if (typeof row.readOnly !== 'boolean') throw new Error('Invalid root access flags.')
  if (row.capacity !== null) {
    const capacity = object(row.capacity)
    count(capacity.total, 'capacity')
    count(capacity.free, 'free capacity')
    if ((capacity.free as number) > (capacity.total as number)) throw new Error('Invalid free capacity.')
  }
  return row as unknown as NativeRoot
}

export function workerInfo(value: unknown): WorkerInfo {
  const row = object(value)
  if (
    !textField(row.id, 'worker ID') ||
    !textField(row.account, 'account') ||
    row.version !== 1 ||
    !['windows', 'macos', 'linux'].includes(String(row.os))
  )
    throw new Error('Unsupported worker identity or version.')
  const capabilities = object(row.capabilities)
  if (
    typeof capabilities.scan !== 'boolean' ||
    typeof capabilities.delete !== 'boolean' ||
    !['undefined', 'boolean'].includes(typeof capabilities.linuxPathTrust)
  )
    throw new Error('Invalid worker capabilities.')
  return row as unknown as WorkerInfo
}

export function decodeFrame(line: string, native = false): WorkerFrame {
  const row = object(JSON.parse(line))
  switch (row.t) {
    case 'hello':
      if (row.v !== 1 || !textField(row.requestId, 'request ID')) throw new Error('Unsupported worker protocol.')
      workerInfo(row.worker)
      break
    case 'root':
      nativeRoot(row.root)
      break
    case 'result':
      break
    case 'fatal':
      textField(row.message, 'failure')
      break
    case 'progress':
      for (const field of ['files', 'dirs', 'bytes']) count(row[field], field)
      break
    case 'dir':
    case 'file':
      if (row.t === 'dir') count(row.id, 'directory ID')
      if (!(row.t === 'dir' && row.parent === null)) count(row.parent, 'parent ID')
      textField(row.name, 'name')
      count(row.size, 'size')
      if (row.t === 'dir') count(row.files, 'files')
      if (row.t === 'dir' && row.errors !== undefined) count(row.errors, 'directory error count')
      timestamp(row.createdAt)
      timestamp(row.lastWrittenAt)
      if (native) {
        // The root's absolute name has no component identity.
        if (!(row.t === 'dir' && row.parent === null)) {
          const encoded = bytes(row.nameBytes, true)
          if (unixLabel(encoded) !== row.name)
            throw new Error('Native display label does not match its exact component.')
        }
        nativeIdentity(row.identity)
      }
      break
    case 'rest':
      for (const field of ['parent', 'size', 'files']) count(row[field], field)
      break
    case 'error':
      textField(row.path, 'error path')
      textField(row.message, 'error message')
      break
    case 'done':
      for (const field of ['size', 'files', 'dirs', 'errors', 'ms']) count(row[field], field)
      if (
        !['walk', 'mft', ...(native ? ['incremental'] : [])].includes(String(row.method)) ||
        !(row.fallback === null || typeof row.fallback === 'string')
      )
        throw new Error('Invalid scan method.')
      if (native && !['complete', 'partial'].includes(String(row.coverage))) throw new Error('Missing scan coverage.')
      if (native) {
        if (row.policy !== 'regular-files-single-mount-no-symlink-traversal')
          throw new Error('Unsupported native traversal policy.')
        const skipped = object(row.skipped)
        for (const field of ['symlinks', 'special', 'mounts']) count(skipped[field], 'policy skip count')
      }
      if (row.coverage === 'complete' && row.errors !== 0) throw new Error('Scan errors contradict complete coverage.')
      break
    default:
      throw new Error('Unknown worker record type.')
  }
  return row as unknown as WorkerFrame
}

/** Keeps a single unfinished frame, rather than buffering a whole worker stream. */
export async function* framedLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let pending = Buffer.alloc(0)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for await (const chunk of stream) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let start = 0
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      if (pending.length + end - start > MAX_FRAME_BYTES) throw new Error('Worker frame exceeds its size limit.')
      const line = Buffer.concat([pending, data.subarray(start, end)])
      pending = Buffer.alloc(0)
      if (!line.length) throw new Error('Worker sent an empty frame.')
      yield decoder.decode(line)
      start = end + 1
    }
    pending = Buffer.concat([pending, data.subarray(start)])
    if (pending.length > MAX_FRAME_BYTES) throw new Error('Worker frame exceeds its size limit.')
  }
  if (pending.length) throw new Error('Worker stream ended in a truncated frame.')
}

export class ScanSequence {
  private dirs = new Map<
    number,
    {
      size: number
      files: number
      errors?: number
      childrenSize: number
      childrenFiles: number
      childrenErrors: number
      names: Set<string>
    }
  >()
  private rootId: number | undefined
  private errors = 0
  private boundRoot = false
  done = false
  private readonly native: boolean
  constructor(native: boolean) {
    this.native = native
  }

  accept(line: ScanLine): void {
    if (this.done) throw new Error('Worker sent records after scan completion.')
    if (line.t === 'root') {
      if (this.boundRoot || this.dirs.size) throw new Error('Worker sent duplicate or late root observation.')
      this.boundRoot = true
      return
    }
    if (line.t === 'progress') return
    if (line.t === 'error') {
      this.errors++
      return
    }
    if (line.t === 'done') {
      const root = this.rootId === undefined ? undefined : this.dirs.get(this.rootId)
      if (
        !root ||
        (this.native && !this.boundRoot) ||
        line.size !== root.size ||
        line.files !== root.files ||
        line.dirs !== this.dirs.size ||
        line.errors < this.errors ||
        (root.errors !== undefined && root.errors !== line.errors)
      )
        throw new Error('Inconsistent scan completion totals.')
      for (const dir of this.dirs.values())
        if (
          dir.childrenSize !== dir.size ||
          dir.childrenFiles !== dir.files ||
          (dir.errors !== undefined && dir.childrenErrors > dir.errors)
        )
          throw new Error('Inconsistent directory totals.')
      this.done = true
      return
    }
    if (this.native && !this.boundRoot) throw new Error('Missing native root observation.')
    if (line.t === 'dir' && line.parent === null) {
      if (this.rootId !== undefined) throw new Error('Worker sent more than one root.')
      this.rootId = line.id
    } else {
      const parent = this.dirs.get(line.parent!)
      if (!parent) throw new Error('Worker sent a child before its parent.')
      const key = line.t === 'rest' ? 'rest' : this.native ? 'u:' + line.nameBytes! : 'w:' + line.name.toLowerCase()
      if (parent.names.has(key)) throw new Error('Worker sent a duplicate entry identity.')
      parent.names.add(key)
      parent.childrenSize = count(parent.childrenSize + line.size, 'directory byte total')
      parent.childrenFiles = count(parent.childrenFiles + (line.t === 'file' ? 1 : line.files), 'directory file total')
      if (line.t === 'dir') {
        // Either every directory reports its error count or none does.
        if ((line.errors === undefined) !== (parent.errors === undefined))
          throw new Error('Worker sent directory error counts for only part of the tree.')
        parent.childrenErrors = count(parent.childrenErrors + (line.errors ?? 0), 'directory error total')
      }
    }
    if (line.t === 'dir') {
      if (this.dirs.has(line.id)) throw new Error('Worker repeated a directory ID.')
      this.dirs.set(line.id, {
        size: line.size,
        files: line.files,
        errors: line.errors,
        childrenSize: 0,
        childrenFiles: 0,
        childrenErrors: 0,
        names: new Set(),
      })
    }
  }
}
