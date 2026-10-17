// Only Electron Node mode is used. This never launches a GUI, registers an app or installs outside its temporary fixture.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const source = resolve(process.argv[2] ?? 'dist/mac-arm64/Disk Watch.app')
const stage = realpathSync(mkdtempSync(join(tmpdir(), 'disk-watch-clean-helper-')))
const destination = join(stage, 'Applications')
mkdirSync(destination)
try {
  const helper = join(source, 'Contents/Resources/install-mac.mjs')
  const contents = readFileSync(helper, 'utf8')
  if (contents.includes("from '@electron/osx-sign'")) throw new Error('Signing dependencies were not bundled.')
  const script = `const { installBundle } = await import(${JSON.stringify('file://' + helper)}); await installBundle(${JSON.stringify(source)}, ${JSON.stringify(destination)}, { register: false });`
  const result = spawnSync(join(source, 'Contents/MacOS/Disk Watch'), ['--input-type=module', '-e', script], {
    cwd: stage,
    env: { HOME: process.env.HOME, TMPDIR: stage, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Clean-machine helper failed: ${result.stdout}\n${result.stderr}`)
  if (readFileSync(join(destination, '.disk-watch-managed'), 'utf8').trim() !== 'com.irudd.diskwatch')
    throw new Error('Missing installed marker.')
  // The bootstrap normally passes /var/folders paths while Node resolves the module to /private/var/folders.
  const normalStage = stage.startsWith('/private/var/') ? stage.slice('/private'.length) : stage
  const cliHelper = join(normalStage, 'install-mac.mjs')
  copyFileSync(helper, cliHelper)
  if (realpathSync(cliHelper) === cliHelper) throw new Error('CLI fixture must use the normal /var temporary path alias.')
  const cliDestination = join(stage, 'CLI Applications')
  mkdirSync(cliDestination)
  const cli = spawnSync(
    join(source, 'Contents/MacOS/Disk Watch'),
    [cliHelper, '--source', source, '--skip-build', '--install-directory', cliDestination, '--no-register'],
    {
      cwd: normalStage,
      env: {
        HOME: process.env.HOME,
        TMPDIR: normalStage,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        ELECTRON_RUN_AS_NODE: '1',
      },
      encoding: 'utf8',
      timeout: 180_000,
    },
  )
  if (cli.error) throw cli.error
  if (cli.status !== 0 || !cli.stdout.includes(`Installed: ${cliDestination}/Disk Watch.app`))
    throw new Error(`Bundled CLI did not install its fixture: ${cli.stdout}\n${cli.stderr}`)
  if (
    !existsSync(join(cliDestination, 'Disk Watch.app/Contents/Info.plist')) ||
    readFileSync(join(cliDestination, '.disk-watch-managed'), 'utf8').trim() !== 'com.irudd.diskwatch'
  )
    throw new Error('Bundled CLI silently skipped installation.')
  console.log(
    'Bundled helper import and actual CLI installed owned fixtures using candidate Electron Node mode, the normal Mac temporary path and system PATH only.',
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
