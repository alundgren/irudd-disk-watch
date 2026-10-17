import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  constructor(
    private readonly file: string,
    private readonly storage: SecretStorage,
    private readonly environmentToken: () => string | undefined = () => process.env.DISK_WATCH_GITHUB_TOKEN,
  ) {
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
    return this.saved ?? this.environmentToken()
  }
  getState(): GitHubAccessState {
    return {
      source: this.saved ? 'saved' : this.environmentToken() ? 'environment' : 'none',
      canSave: this.storage.isEncryptionAvailable(),
      ...(this.message ? { message: this.message } : {}),
    }
  }
  private validate(token: unknown): asserts token is string {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{20,512}$/.test(token))
      throw new Error('Enter a GitHub token of 20 to 512 characters without spaces or line breaks.')
  }
  private readSaved(): Buffer | undefined {
    let stat
    try {
      stat = lstatSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 16_384 ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw new Error('The saved GitHub access file is unsafe.')
    return readFileSync(this.file)
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
    // Refuse links and foreign files instead of replacing an unexpected destination.
    this.readSaved()
    const temporary = join(dirname(this.file), `.github-access-${randomUUID()}`)
    try {
      writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
    this.saved = token
    this.message = undefined
    return this.getState()
  }
  clear(): GitHubAccessState {
    this.readSaved()
    rmSync(this.file, { force: true })
    this.saved = undefined
    this.message = undefined
    return this.getState()
  }
}
