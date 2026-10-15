import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let command
let launchArgs
if (process.platform === 'win32') {
  command = 'powershell'
  // JSON avoids passing user arguments through PowerShell's command parser.
  const encoded = Buffer.from(JSON.stringify(args), 'utf8').toString('base64')
  launchArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileURLToPath(new URL('./start-admin.ps1', import.meta.url)),
    '-EncodedArguments',
    encoded,
  ]
} else {
  command = createRequire(import.meta.url)('electron')
  launchArgs = [root, ...args]
}
const result = spawnSync(command, launchArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true })
if (result.error) console.error(`Could not start Disk Watch: ${result.error.message}`)
process.exitCode = result.status ?? 1
