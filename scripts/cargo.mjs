import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const options = {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  windowsHide: true,
}

let result = spawnSync('cargo', args, options)
if (result.error?.code === 'ENOENT') {
  const bin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin')
  const cargo = join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const path = process.env[pathKey]
  result = spawnSync(cargo, args, {
    ...options,
    env: { ...process.env, [pathKey]: path ? `${path}${delimiter}${bin}` : bin },
  })
  if (result.error?.code === 'ENOENT') {
    console.error(
      `Cargo was not found on PATH or at ${cargo}. Install Rust with the MSVC toolchain, or set CARGO_HOME to its installation directory.`,
    )
    process.exit(1)
  }
}

if (result.error) console.error(`Could not start Cargo: ${result.error.message}`)
process.exitCode = result.status ?? 1
