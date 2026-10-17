import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { GitHubAccessState } from '../shared/githubAccess'

interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** The renderer receives status only. Saved credentials remain encrypted on disk. */
export class GitHubAccess {
  private saved?: string
  private message?: string
  private hasSavedRecord = false
  private readonly file: string
  private readonly storage: SecretStorage
  private readonly environmentToken: () => string | undefined
  constructor(
    file: string,
    storage: SecretStorage,
    environmentToken: () => string | undefined = () => process.env.DISK_WATCH_GITHUB_TOKEN,
  ) {
    this.file = file
    this.storage = storage
    this.environmentToken = environmentToken
    try {
      const bytes = this.readSaved()
      if (bytes) {
        if (!storage.isEncryptionAvailable()) throw new Error('Encryption is unavailable.')
        this.saved = storage.decryptString(bytes)
        this.validate(this.saved)
      }
    } catch {
      this.saved = undefined
      this.message = 'Saved GitHub access could not be unlocked. Save your token again, or remove the saved access.'
    }
  }
  get token(): string | undefined {
    if (this.saved) return this.saved
    const token = this.environmentToken()
    if (token) this.validate(token)
    return token || undefined
  }
  getState(): GitHubAccessState {
    let source: GitHubAccessState['source'] = this.saved ? 'saved' : 'none'
    let message = this.message
    if (!this.saved) {
      try {
        if (this.token) source = 'environment'
      } catch {
        message = 'The environment GitHub token is invalid. Remove it or provide a token without spaces or line breaks.'
      }
    }
    return {
      source,
      hasSavedRecord: this.hasSavedRecord,
      canSave: this.storage.isEncryptionAvailable(),
      ...(message ? { message } : {}),
    }
  }
  private validate(token: unknown): asserts token is string {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(token))
      throw new Error('Enter a GitHub token of 20 to 512 characters without spaces or line breaks.')
  }
  private directory(): string | undefined {
    const parent = dirname(this.file)
    let stat
    try {
      stat = lstatSync(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error('The GitHub access directory must be a private, account-owned directory without links.')
    const canonical = realpathSync(parent)
    if (process.platform !== 'win32') {
      let ancestor = dirname(canonical)
      while (true) {
        const entry = lstatSync(ancestor)
        const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0
        if (
          !entry.isDirectory() ||
          (entry.uid !== 0 && entry.uid !== process.getuid?.()) ||
          ((entry.mode & 0o022) !== 0 && !stickyRoot)
        )
          throw new Error('A GitHub access parent directory can be changed by another account.')
        const next = dirname(ancestor)
        if (next === ancestor) break
        ancestor = next
      }
    }
    return canonical
  }
  private record(): { path: string; stat: Stats } | undefined {
    const parent = this.directory()
    if (!parent) return undefined
    const path = join(parent, basename(this.file))
    let stat
    try {
      stat = lstatSync(path)
      this.hasSavedRecord = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.hasSavedRecord = false
        return undefined
      }
      throw error
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error('The saved GitHub access file is unsafe.')
    return { path, stat }
  }
  private readSaved(): Buffer | undefined {
    const record = this.record()
    if (!record) return undefined
    const fd = openSync(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const current = fstatSync(fd)
      if (
        !current.isFile() ||
        current.dev !== record.stat.dev ||
        current.ino !== record.stat.ino ||
        current.nlink !== 1 ||
        (process.platform !== 'win32' && (current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0))
      )
        throw new Error('The saved GitHub access file changed while opening it.')
      const bytes = Buffer.alloc(16_385)
      const count = readSync(fd, bytes, 0, bytes.length, 0)
      if (count > 16_384) throw new Error('The saved GitHub access record is too large.')
      return bytes.subarray(0, count)
    } finally {
      closeSync(fd)
    }
  }
  save(token: string): GitHubAccessState {
    this.validate(token)
    if (!this.storage.isEncryptionAvailable())
      throw new Error('OS credential encryption is unavailable. GitHub access was not saved.')
    let encrypted: Buffer
    try {
      encrypted = this.storage.encryptString(token)
    } catch {
      throw new Error('The OS could not encrypt GitHub access. Your previous access was retained.')
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const parent = this.directory()!
    this.record()
    const temporary = join(parent, `.github-access-${randomUUID()}`)
    try {
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, join(parent, basename(this.file)))
    } finally {
      rmSync(temporary, { force: true })
    }
    this.saved = token
    this.hasSavedRecord = true
    this.message = undefined
    return this.getState()
  }
  clear(): GitHubAccessState {
    const record = this.record()
    if (record) rmSync(record.path)
    this.saved = undefined
    this.hasSavedRecord = false
    this.message = undefined
    return this.getState()
  }
}
