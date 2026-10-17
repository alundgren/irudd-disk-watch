import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { AppUpdates, isNewerVersion, macHandoff } from './appUpdates'
import * as releases from './releases'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))
vi.mock('./releases', () => ({ getRelease: vi.fn(), downloadReleaseAsset: vi.fn() }))
const fixtures: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disk-watch-updates-'))
  fixtures.push(root)
  const app = join(root, 'Disk Watch'),
    resources = join(app, 'resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(app, '.disk-watch-managed'), 'com.irudd.diskwatch')
  await writeFile(join(resources, 'install-windows.ps1'), 'fixture helper')
  const options = {
    version: '0.2.0',
    isPackaged: true,
    execPath: join(app, 'Disk Watch.exe'),
    resourcesPath: resources,
    cacheDirectory: join(root, 'cache'),
    userDataDirectory: join(root, 'profile'),
    platform: 'win32' as const,
    arch: 'x64',
    isFilesystemBusy: vi.fn(() => false),
    quit: vi.fn(),
  }
  vi.mocked(releases.getRelease).mockResolvedValue({ version: '0.3.0', assets: {} })
  vi.mocked(releases.downloadReleaseAsset).mockResolvedValue(Buffer.from('verified update'))
  return { root, options, updates: new AppUpdates(options) }
}
it('compares stable versions numerically and refuses downgrades or prereleases', () => {
  expect(isNewerVersion('0.10.0', '0.2.0')).toBe(true)
  for (const candidate of ['0.1.9', '0.2.0', '0.3.0-beta', 'bad'])
    expect(isNewerVersion(candidate, '0.2.0')).toBe(false)
})
it('shows initial installation guidance for a development app without downloading', async () => {
  const { options } = await fixture()
  const updates = new AppUpdates({ ...options, isPackaged: false })
  expect((await updates.check()).phase).toBe('unmanaged')
  expect(releases.getRelease).not.toHaveBeenCalled()
})
it('reports check/download progress, errors and a successful retry', async () => {
  const { updates } = await fixture()
  const phases: string[] = []
  updates.on('state', (state) => phases.push(state.phase))
  expect((await updates.check()).phase).toBe('available')
  vi.mocked(releases.downloadReleaseAsset).mockRejectedValueOnce(new Error('network unavailable'))
  expect(await updates.download()).toMatchObject({ phase: 'error', retry: 'download', message: 'network unavailable' })
  expect((await updates.download()).phase).toBe('ready')
  expect(phases).toEqual(['checking', 'available', 'downloading', 'error', 'downloading', 'ready'])
})
it('blocks restart during filesystem work and keeps a verified candidate for retry', async () => {
  const { options, updates } = await fixture()
  await updates.check()
  await updates.download()
  options.isFilesystemBusy.mockReturnValue(true)
  expect(await updates.installAndRestart()).toMatchObject({
    phase: 'error',
    retry: 'install',
    message: expect.stringContaining('file operations'),
  })
  expect(options.quit).not.toHaveBeenCalled()
})
it('detects staged-file tampering before any process is spawned and requires a fresh download', async () => {
  const { root, options, updates } = await fixture()
  await updates.check()
  await updates.download()
  const { readdir } = await import('node:fs/promises')
  const stage = (await readdir(join(root, 'cache')))[0]!
  await writeFile(join(root, 'cache', stage, 'Disk-Watch-0.3.0-x64-Setup.exe'), 'tampered')
  expect(await updates.installAndRestart()).toMatchObject({
    phase: 'error',
    retry: 'check',
    message: expect.stringContaining('verification failed'),
  })
  expect(options.quit).not.toHaveBeenCalled()
})
it('rejects an update cache inside the installed directory', async () => {
  const { options } = await fixture()
  const updates = new AppUpdates({ ...options, cacheDirectory: join(options.resourcesPath, 'cache') })
  await updates.check()
  expect(await updates.download()).toMatchObject({ phase: 'error', message: expect.stringContaining('outside') })
})
it('serializes update actions while a check is pending', async () => {
  const { updates } = await fixture()
  let finish!: (value: releases.Release) => void
  vi.mocked(releases.getRelease).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const checking = updates.check()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect((await updates.download()).phase).toBe('checking')
  finish({ version: '0.3.0', assets: {} })
  await checking
  expect(releases.downloadReleaseAsset).not.toHaveBeenCalled()
})
it.skipIf(process.platform === 'win32')(
  'runs a detached shell helper from the staged candidate, preserves the profile and does not launch on failure',
  async () => {
    const root = await mkdtemp(join(tmpdir(), "disk-watch-handoff-'"))
    fixtures.push(root)
    const candidate = join(root, 'candidate.app'),
      stage = join(root, 'stage')
    await mkdir(join(candidate, 'Contents/MacOS'), { recursive: true })
    await mkdir(stage)
    const runtime = join(candidate, 'Contents/MacOS/Disk Watch')
    const argsFile = join(root, 'arguments')
    await writeFile(
      runtime,
      `#!/bin/sh\nprintf '%s\\n' "$ELECTRON_RUN_AS_NODE" "$@" > '${argsFile.replaceAll("'", "'\\''")}'\nexit 17\n`,
      { mode: 0o700 },
    )
    const script = join(stage, 'handoff.sh')
    const body = macHandoff({
      pid: 2147483647,
      candidate,
      stage,
      directory: join(root, 'Applications'),
      profile: join(root, "profile with ' and spaces"),
    })
    await writeFile(script, body)
    // The fake candidate always fails. set -e must prevent the real system open command from running.
    expect(() =>
      execFileSync('/bin/sh', [script], { env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--invalid' } }),
    ).toThrow()
    const argumentsText = await readFile(argsFile, 'utf8')
    expect(argumentsText).toContain('1\n')
    expect(argumentsText).toContain(join(stage, 'install-mac.mjs'))
    expect(body).toContain('while /bin/kill -0')
    expect(body).toContain('--user-data-dir=')
    expect(body).not.toMatch(/\bnode /)
  },
)

it('refuses to replace an app containing its custom profile', async () => {
  const { options } = await fixture()
  const updates = new AppUpdates({ ...options, userDataDirectory: join(options.resourcesPath, 'profile') })
  expect(await updates.check()).toMatchObject({
    phase: 'unmanaged',
    message: expect.stringContaining('profile outside'),
  })
  expect(releases.getRelease).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'darwin')(
  're-extracts the verified Mac archive to a fresh candidate before handoff',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'disk-watch-mac-update-'))
    fixtures.push(root)
    const directory = join(root, 'Applications'),
      archiveRoot = join(root, 'archive')
    const target = join(directory, 'Disk Watch.app'),
      source = join(archiveRoot, 'Disk Watch.app')
    for (const app of [target, source]) {
      await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
      await mkdir(join(app, 'Contents/Resources'), { recursive: true })
      await writeFile(
        join(app, 'Contents/Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.irudd.diskwatch</string><key>CFBundleShortVersionString</key><string>0.3.0</string></dict></plist>',
      )
      await writeFile(join(app, 'Contents/MacOS/Disk Watch'), '#!/bin/sh\nexit 17\n', { mode: 0o700 })
      await writeFile(join(app, 'Contents/Resources/install-mac.mjs'), 'fixture helper')
      await writeFile(join(app, 'Contents/Resources/app.asar'), 'fixture archive')
    }
    await writeFile(join(directory, '.disk-watch-managed'), 'com.irudd.diskwatch')
    const archive = join(root, 'update.tar.gz')
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', archiveRoot, 'Disk Watch.app'])
    vi.mocked(releases.getRelease).mockResolvedValue({ version: '0.3.0', assets: {} })
    vi.mocked(releases.downloadReleaseAsset).mockResolvedValue(await readFile(archive))
    const fakeChild = Object.assign(new EventEmitter(), { unref: vi.fn() })
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => fakeChild.emit('spawn'))
      return fakeChild as unknown as ReturnType<typeof spawn>
    })
    const quit = vi.fn()
    const updates = new AppUpdates({
      version: '0.2.0',
      isPackaged: true,
      execPath: join(target, 'Contents/MacOS/Disk Watch'),
      resourcesPath: join(target, 'Contents/Resources'),
      cacheDirectory: join(root, 'cache'),
      userDataDirectory: join(root, 'profile'),
      platform: 'darwin',
      arch: 'arm64',
      isFilesystemBusy: () => false,
      quit,
    })
    await updates.check()
    expect((await updates.download()).phase).toBe('ready')
    expect((await updates.installAndRestart()).phase).toBe('installing')
    expect(quit).toHaveBeenCalledOnce()
    expect(fakeChild.unref).toHaveBeenCalledOnce()
    const { readdir } = await import('node:fs/promises')
    const stage = join(root, 'cache', (await readdir(join(root, 'cache')))[0]!)
    const handoff = await readFile(join(stage, 'update.sh'), 'utf8')
    expect(handoff).toContain('/verified-')
    expect(await readFile(join(stage, 'Disk Watch.app/Contents/Resources/app.asar'), 'utf8')).toBe('fixture archive')
  },
)

it('omits GitHub credentials and inherited PowerShell module paths from the detached installer', async () => {
  const { root, updates } = await fixture()
  vi.stubEnv('DISK_WATCH_GITHUB_TOKEN', 'environment-only-test-token')
  vi.stubEnv('PSModulePath', 'PowerShell7-test-modules')
  if (process.platform !== 'win32') {
    vi.stubEnv('disk_watch_github_token', 'lowercase-test-token')
    vi.stubEnv('psmodulepath', 'lowercase-test-modules')
  }
  vi.stubEnv('DISK_WATCH_TEST_KEEP', 'retained')
  const fakeChild = Object.assign(new EventEmitter(), { unref: vi.fn() })
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => fakeChild.emit('spawn'))
    return fakeChild as unknown as ReturnType<typeof spawn>
  })
  await updates.check()
  await updates.download()
  expect((await updates.installAndRestart()).phase).toBe('installing')
  const childEnv = vi.mocked(spawn).mock.calls[0]![2]!.env!
  expect(Object.keys(childEnv).some((key) => key.toUpperCase() === 'DISK_WATCH_GITHUB_TOKEN')).toBe(false)
  expect(Object.keys(childEnv).some((key) => key.toUpperCase() === 'PSMODULEPATH')).toBe(false)
  expect(childEnv.DISK_WATCH_TEST_KEEP).toBe('retained')
  expect(process.env.PSModulePath).toBe('PowerShell7-test-modules')
  expect(process.env.DISK_WATCH_GITHUB_TOKEN).toBe('environment-only-test-token')
  const { readdir } = await import('node:fs/promises')
  const stage = join(root, 'cache', (await readdir(join(root, 'cache')))[0]!)
  for (const file of await readdir(stage)) {
    const contents = await readFile(join(stage, file), 'utf8')
    expect(contents).not.toContain('environment-only-test-token')
    expect(contents).not.toContain('lowercase-test-token')
  }
})
