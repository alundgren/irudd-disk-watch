// Only Electron Node mode is used. This never launches a GUI, registers an app or installs outside its temporary fixture.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
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
  console.log('Bundled helper installed its owned fixture using candidate Electron Node mode and system PATH only.')
} finally {
  rmSync(stage, { recursive: true, force: true })
}
