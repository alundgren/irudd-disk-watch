import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Mac icon generation requires macOS sips and iconutil.')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'dist')
const temporary = mkdtempSync(join(tmpdir(), 'disk-watch-icon-'))
const iconset = join(temporary, 'icon.iconset')
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}
try {
  mkdirSync(output, { recursive: true })
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale)
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      run('/usr/bin/sips', [
        '--resampleHeightWidth',
        pixels,
        pixels,
        join(root, 'build/icon.png'),
        '--out',
        join(iconset, name),
      ])
    }
  }
  run('/usr/bin/iconutil', ['--convert', 'icns', '--output', join(output, 'icon.icns'), iconset])
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
