import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = process.argv[2] ?? 'release'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== `v${version}`)
  throw new Error('Tag and package version must match.')
const expected = [
  'Disk-Watch-mac-arm64.tar.gz',
  `Disk-Watch-${version}-x64-Setup.exe`,
  'dw-scan-linux-x64',
  'dw-scan-linux-arm64',
].sort()
if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected))
  throw new Error('Release must contain exactly the four expected assets, without an existing checksum file.')
writeFileSync(
  join(directory, 'SHA256SUMS'),
  expected
    .map(
      (name) =>
        `${createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex')}  ${name}\n`,
    )
    .join(''),
)
