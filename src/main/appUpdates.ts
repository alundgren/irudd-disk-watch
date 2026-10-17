import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadReleaseAsset, getRelease, type Release } from './releases'
import type { UpdateAction, UpdateState } from '../shared/updates'

const exec = promisify(execFile)
const appName = 'Disk Watch.app'
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const isNewerVersion = (candidate: string, current: string) => {
  if (![candidate, current].every((value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))) return false
  const left = candidate.split('.').map(Number),
    right = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) return true
    if (left[i]! < right[i]!) return false
  }
  return false
}

type Options = {
  version: string
  isPackaged: boolean
  execPath: string
  resourcesPath: string
  /** A private app cache outside the installed app, for example app.getPath('cache')/disk-watch-updates. */
  cacheDirectory: string
  userDataDirectory: string
  isFilesystemBusy(): boolean
  quit(): void
  platform?: NodeJS.Platform
  arch?: string
}
type Prepared = { stage: string; asset: string; hash: string; candidate?: string }

/** The renderer supplies actions only. All paths, versions and executable arguments come from the main process. */
export class AppUpdates extends EventEmitter {
  private state: UpdateState
  private release?: Release
  private prepared?: Prepared
  private working = false
  private platform: NodeJS.Platform
  private arch: string
  private readonly options: Options
  constructor(options: Options) {
    super()
    this.options = options
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.state = { phase: 'idle', currentVersion: options.version }
  }
  getState(): UpdateState {
    return { ...this.state }
  }
  isInstalling(): boolean {
    return this.state.phase === 'installing'
  }
  private set(values: Partial<UpdateState>): UpdateState {
    this.state = {
      currentVersion: this.options.version,
      availableVersion: this.release?.version,
      ...values,
    } as UpdateState
    this.emit('state', this.getState())
    return this.getState()
  }
  private async assertProfileOutsideApp(target: string): Promise<void> {
    const profile = await realpath(this.options.userDataDirectory).catch(() => resolve(this.options.userDataDirectory))
    const installed = await realpath(target).catch(() => resolve(target))
    const canonical = (value: string) => (this.platform === 'win32' ? value.toLowerCase() : value)
    const paths = [
      [profile, installed],
      [resolve(this.options.userDataDirectory), resolve(target)],
    ]
    if (
      paths.some(
        ([data, app]) => canonical(data!) === canonical(app!) || canonical(data!).startsWith(canonical(app!) + sep),
      )
    )
      throw new Error('Move the custom profile outside the installed app before updating. Your data was not changed.')
  }
  private async managedDirectory(): Promise<string> {
    const o = this.options
    if (!o.isPackaged || !isAbsolute(o.execPath) || !isAbsolute(o.cacheDirectory) || !isAbsolute(o.userDataDirectory))
      throw new Error('Use the prebuilt installer to enable app updates.')
    if (this.platform === 'darwin' && this.arch === 'arm64') {
      const directory = resolve(o.execPath, '../../../..')
      const target = join(directory, appName)
      if (o.execPath !== join(target, 'Contents/MacOS/Disk Watch') || (await lstat(target)).isSymbolicLink())
        throw new Error('Install Disk Watch at a stable Applications path before updating.')
      if ((await readFile(join(directory, '.disk-watch-managed'), 'utf8')).trim() !== 'com.irudd.diskwatch')
        throw new Error('Run the prebuilt installer once to enable app updates.')
      await this.assertProfileOutsideApp(target)
      return directory
    }
    if (this.platform === 'win32' && this.arch === 'x64') {
      const directory = dirname(o.execPath)
      if (
        dirname(o.resourcesPath) !== directory ||
        (await readFile(join(directory, '.disk-watch-managed'), 'utf8')).trim() !== 'com.irudd.diskwatch'
      )
        throw new Error('Run the prebuilt installer once to enable app updates.')
      await this.assertProfileOutsideApp(directory)
      return directory
    }
    throw new Error('App updates support macOS ARM64 and Windows x64. Use the prebuilt installer for this computer.')
  }
  private async action(retry: UpdateAction, run: () => Promise<UpdateState>): Promise<UpdateState> {
    if (this.working || this.isInstalling()) return this.getState()
    this.working = true
    try {
      return await run()
    } catch (error) {
      return this.set({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        retry: retry === 'install' && !this.prepared ? 'check' : retry,
      })
    } finally {
      this.working = false
    }
  }
  async check(): Promise<UpdateState> {
    return this.action('check', async () => {
      try {
        await this.managedDirectory()
      } catch (error) {
        return this.set({
          phase: 'unmanaged',
          message: `${error instanceof Error ? error.message : error} See docs/installing.md in the project repository.`,
        })
      }
      this.set({ phase: 'checking', message: 'Checking the latest stable release…' })
      this.release = await getRelease()
      this.prepared = undefined
      return this.set({ phase: isNewerVersion(this.release.version, this.options.version) ? 'available' : 'current' })
    })
  }
  async download(): Promise<UpdateState> {
    return this.action('download', async () => {
      await this.managedDirectory()
      if (!this.release || !isNewerVersion(this.release.version, this.options.version))
        throw new Error('Check for a newer release first.')
      this.set({ phase: 'downloading', message: 'Downloading and verifying the update…' })
      const name =
        this.platform === 'darwin' ? 'Disk-Watch-mac-arm64.tar.gz' : `Disk-Watch-${this.release.version}-x64-Setup.exe`
      const bytes = await downloadReleaseAsset(this.release, name)
      const cache = this.options.cacheDirectory
      await mkdir(cache, { recursive: true, mode: 0o700 })
      const stat = await lstat(cache)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && stat.uid !== process.getuid?.())
      )
        throw new Error('Unsafe update cache directory.')
      const resolvedCache = await realpath(cache)
      const install = await realpath(await this.managedDirectory())
      if (resolvedCache === install || resolvedCache.startsWith(install + sep))
        throw new Error('The update cache must be outside the install directory.')
      await chmod(cache, 0o700)
      const stage = await mkdtemp(join(cache, 'update-'))
      const asset = join(stage, name)
      await writeFile(asset, bytes, { mode: 0o600, flag: 'wx' })
      const prepared: Prepared = { stage, asset, hash: digest(bytes) }
      if (this.platform === 'darwin') {
        const { stdout } = await exec('/usr/bin/tar', ['-tzf', asset], { maxBuffer: 16 * 1024 * 1024 })
        if (
          !stdout.trim() ||
          stdout
            .trimEnd()
            .split('\n')
            .some((entry) => !/^Disk Watch\.app(\/|$)/.test(entry) || entry.split('/').includes('..'))
        )
          throw new Error('Unsafe update archive.')
        await exec('/usr/bin/tar', ['-xzf', asset, '-C', stage])
        prepared.candidate = join(stage, appName)
        const { stdout: version } = await exec('/usr/bin/plutil', [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          join(prepared.candidate, 'Contents/Info.plist'),
        ])
        const { stdout: identifier } = await exec('/usr/bin/plutil', [
          '-extract',
          'CFBundleIdentifier',
          'raw',
          '-o',
          '-',
          join(prepared.candidate, 'Contents/Info.plist'),
        ])
        if (version.trim() !== this.release.version || identifier.trim() !== 'com.irudd.diskwatch')
          throw new Error('Update app version or identifier does not match the release.')
        const helper = join(prepared.candidate, 'Contents/Resources/install-mac.mjs')
        if (!(await lstat(helper)).isFile() || (await lstat(helper)).isSymbolicLink())
          throw new Error('Update installer helper is missing.')
        await copyFile(helper, join(stage, 'install-mac.mjs'))
      } else {
        await copyFile(join(this.options.resourcesPath, 'install-windows.ps1'), join(stage, 'install-windows.ps1'))
      }
      this.prepared = prepared
      return this.set({
        phase: 'ready',
        message: 'Update verified. Install and restart when your file operations have finished.',
      })
    })
  }
  async installAndRestart(): Promise<UpdateState> {
    return this.action('install', async () => {
      const directory = await this.managedDirectory()
      if (this.options.isFilesystemBusy())
        throw new Error('Finish or cancel scans and file operations before restarting.')
      const p = this.prepared
      if (!p) throw new Error('Download and verify the update first.')
      if (digest(await readFile(p.asset)) !== p.hash) {
        this.prepared = undefined
        this.release = undefined
        throw new Error('Staged update verification failed. Check and download the update again.')
      }
      // Re-extract verified bytes so changes to the extracted runtime/helper cannot be executed.
      if (p.candidate) {
        // Electron treats app.asar as a virtual directory. Use a fresh extraction instead of traversing it with fs.rm.
        const verified = await mkdtemp(join(p.stage, 'verified-'))
        await exec('/usr/bin/tar', ['-xzf', p.asset, '-C', verified])
        p.candidate = join(verified, appName)
        await copyFile(join(p.candidate, 'Contents/Resources/install-mac.mjs'), join(p.stage, 'install-mac.mjs'))
      }
      const log = join(p.stage, 'update.log')
      let command: string, args: string[]
      if (p.candidate) {
        command = '/bin/sh'
        const script = join(p.stage, 'update.sh')
        await writeFile(
          script,
          macHandoff({
            pid: process.pid,
            candidate: p.candidate,
            stage: p.stage,
            directory,
            profile: this.options.userDataDirectory,
          }),
          { mode: 0o700 },
        )
        args = [script]
      } else {
        command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
        const script = join(p.stage, 'handoff.ps1')
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
        await writeFile(
          script,
          `$ErrorActionPreference = 'Stop'\ntry {\n & ${quote(join(p.stage, 'install-windows.ps1'))} -Installer ${quote(p.asset)} -ExpectedHash ${quote(p.hash)} -InstallDirectory ${quote(directory)} -ParentProcessId ${process.pid} -ProfileDirectory ${quote(this.options.userDataDirectory)} -Restart *>> ${quote(log)}\n} catch { $_ | Out-File -Append -LiteralPath ${quote(log)}; exit 1 }\n`,
        )
        args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
      }
      if (this.options.isFilesystemBusy())
        throw new Error('Finish or cancel scans and file operations before restarting.')
      this.set({
        phase: 'installing',
        message: `Restarting to install the update. Failure details are saved to ${log}`,
      })
      try {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
        for (const key of Object.keys(childEnv))
          if (['DISK_WATCH_GITHUB_TOKEN', 'PSMODULEPATH'].includes(key.toUpperCase())) delete childEnv[key]
        const child = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          cwd: p.stage,
          env: childEnv,
        })
        await new Promise<void>((resolveSpawn, reject) => {
          child.once('spawn', resolveSpawn)
          child.once('error', reject)
        })
        child.unref()
      } catch (error) {
        this.set({ phase: 'ready' })
        throw error
      }
      this.options.quit()
      return this.getState()
    })
  }
}

export function macHandoff(p: {
  pid: number
  candidate: string
  stage: string
  directory: string
  profile: string
}): string {
  return `#!/bin/sh\nset -eu\nexec >>${shellQuote(join(p.stage, 'update.log'))} 2>&1\ncount=0\nwhile /bin/kill -0 ${p.pid} 2>/dev/null; do\n count=$((count + 1))\n [ "$count" -lt 120 ] || { echo 'App did not exit within two minutes'; exit 1; }\n /bin/sleep 1\ndone\nunset NODE_OPTIONS NODE_PATH\nPATH=/usr/bin:/bin:/usr/sbin:/sbin\nexport PATH\nELECTRON_RUN_AS_NODE=1 ${shellQuote(join(p.candidate, 'Contents/MacOS/Disk Watch'))} ${shellQuote(join(p.stage, 'install-mac.mjs'))} --source ${shellQuote(p.candidate)} --skip-build --install-directory ${shellQuote(p.directory)}\n/usr/bin/open -n ${shellQuote(join(p.directory, appName))} --args ${shellQuote(`--user-data-dir=${p.profile}`)}\n`
}
