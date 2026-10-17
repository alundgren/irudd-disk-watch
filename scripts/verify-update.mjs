// Hosted isolated desktops only. This deliberately opens and restarts an installed fixture app.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'
if (process.env.CI !== 'true') throw new Error('Update GUI smoke tests require an isolated hosted CI desktop.')
const mac = process.platform === 'darwin'
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'dw-update-smoke-')))
const directory = join(fixture, mac ? 'Applications' : 'Disk Watch')
const profile = join(fixture, 'custom profile')
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
const name = mac ? 'Disk-Watch-mac-arm64.tar.gz' : `Disk-Watch-${version}-x64-Setup.exe`
const asset = readFileSync(resolve('dist', name))
const executable = mac ? join(directory, 'Disk Watch.app/Contents/MacOS/Disk Watch') : join(directory, 'Disk Watch.exe')
const systemPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 180_000, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr)
  return result.stdout.trim()
}
const fixturePids = () => {
  if (mac)
    return run('/bin/ps', ['-axww', '-o', 'pid=,comm='])
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        return match && match[2] === executable ? [Number(match[1])] : []
      })
  return JSON.parse(
    run(systemPowerShell, [
      '-NoProfile',
      '-Command',
      `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, '${executable.replaceAll("'", "''")}') } | Select-Object -ExpandProperty ProcessId)`,
    ]) || '[]',
  )
}
let app
let success = false
try {
  mkdirSync(profile)
  if (mac) {
    mkdirSync(directory)
    const source = resolve('dist/mac-arm64/Disk Watch.app')
    run(
      join(source, 'Contents/MacOS/Disk Watch'),
      [
        '--input-type=module',
        '-e',
        `const { installBundle } = await import(${JSON.stringify(pathToFileURL(join(source, 'Contents/Resources/install-mac.mjs')).href)}); await installBundle(${JSON.stringify(source)}, ${JSON.stringify(directory)}, { register: false });`,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' } },
    )
  } else {
    run(systemPowerShell, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('scripts/install-windows.ps1'),
      '-Installer',
      resolve('dist', name),
      '-ExpectedHash',
      createHash('sha256').update(asset).digest('hex'),
      '-InstallDirectory',
      directory,
    ])
  }
  const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], env })
  await app.firstWindow()
  const oldPid = app.process().pid
  const modulePath = resolve('dist/update-smoke/app-updates.cjs')
  const closed = app.waitForEvent('close', { timeout: 120_000 })
  await app.evaluate(
    async ({ app }, data) => {
      const fs = process.getBuiltinModule('fs')
      const path = process.getBuiltinModule('path')
      const crypto = process.getBuiltinModule('crypto')
      const { AppUpdates } = process.getBuiltinModule('module').createRequire(data.modulePath)(data.modulePath)
      const repo = 'alundgren/irudd-disk-watch'
      const names = [
        'Disk-Watch-mac-arm64.tar.gz',
        `Disk-Watch-${data.version}-x64-Setup.exe`,
        'dw-scan-linux-x64',
        'dw-scan-linux-arm64',
      ]
      const prefix = `https://github.com/${repo}/releases/download/v${data.version}/`
      const bytes = fs.readFileSync(data.assetPath)
      const hash = crypto.createHash('sha256').update(bytes).digest('hex')
      const metadata = {
        tag_name: `v${data.version}`,
        draft: false,
        prerelease: false,
        assets: [...names, 'SHA256SUMS'].map((name) => ({
          name,
          state: 'uploaded',
          browser_download_url: prefix + name,
        })),
      }
      globalThis.fetch = async (url) =>
        new Response(
          String(url).includes('api.github.com')
            ? JSON.stringify(metadata)
            : String(url).endsWith('SHA256SUMS')
              ? names.map((name) => `${hash}  ${name}\n`).join('')
              : bytes,
        )
      const updates = new AppUpdates({
        version: '0.0.0',
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        cacheDirectory: data.cache,
        userDataDirectory: app.getPath('userData'),
        isFilesystemBusy: () => false,
        quit: () => {
          setTimeout(() => app.quit(), 200)
        },
      })
      if ((await updates.check()).phase !== 'available') throw new Error(JSON.stringify(updates.getState()))
      if ((await updates.download()).phase !== 'ready') throw new Error(JSON.stringify(updates.getState()))
      if ((await updates.installAndRestart()).phase !== 'installing')
        throw new Error(JSON.stringify(updates.getState()))
      fs.writeFileSync(path.join(app.getPath('userData'), 'update-profile-sentinel'), 'preserved')
    },
    { modulePath, version, assetPath: resolve('dist', name), cache: join(fixture, 'cache') },
  )
  await closed
  app = undefined
  const deadline = Date.now() + 120_000
  let reopened = []
  while (Date.now() < deadline) {
    reopened = fixturePids().filter((pid) => pid !== oldPid)
    if (reopened.length) break
    await new Promise((finish) => setTimeout(finish, 1000))
  }
  assert.ok(reopened.length, `Updated app did not restart; inspect ${fixture}/cache`)
  assert.equal(readFileSync(join(profile, 'update-profile-sentinel'), 'utf8'), 'preserved')
  success = true
  console.log('Packaged AppUpdates check/download/detached install/restart passed with a custom profile.')
} finally {
  if (app) await app.close().catch(() => {})
  for (const pid of fixturePids()) {
    try {
      process.kill(pid)
    } catch {}
  }
  await new Promise((finish) => setTimeout(finish, 2000))
  if (!success) console.error(`Update fixture retained for failure diagnosis: ${fixture}`)
  if (success && process.env.KEEP_UPDATE_FIXTURE !== '1') rmSync(fixture, { recursive: true, force: true })
}
