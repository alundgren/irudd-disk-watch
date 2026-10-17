import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AppUpdates, isNewerVersion, macHandoff } from './appUpdates'
import * as releases from './releases'

vi.mock('./releases', () => ({ getRelease: vi.fn(), downloadReleaseAsset: vi.fn() }))
const fixtures: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
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
