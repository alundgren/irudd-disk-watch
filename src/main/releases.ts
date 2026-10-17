import { createHash, timingSafeEqual } from 'node:crypto'

export const RELEASE_REPOSITORY = 'alundgren/irudd-disk-watch'
const api = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`
const downloads = `https://github.com/${RELEASE_REPOSITORY}/releases/download/`
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_ASSET = 700 * 1024 * 1024
const MAX_METADATA = 1024 * 1024
const TIMEOUT = 180_000

export type Release = {
  version: string
  assets: Readonly<Record<string, string>>
  assetIds?: Readonly<Record<string, number>>
}
export function releaseAssetNames(version: string): string[] {
  if (!versionPattern.test(version)) throw new Error('Invalid stable release version.')
  return [
    'Disk-Watch-mac-arm64.tar.gz',
    `Disk-Watch-${version}-x64-Setup.exe`,
    'dw-scan-linux-x64',
    'dw-scan-linux-arm64',
  ]
}

async function fetchBytes(url: string, limit: number): Promise<Buffer> {
  // Only the initial URL is supplied by this module. GitHub redirects asset downloads to its CDN.
  const signal = AbortSignal.timeout(TIMEOUT)
  let current = url
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(current)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      ![
        'api.github.com',
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(parsed.hostname)
    )
      throw new Error('Release download redirected outside GitHub.')
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        Accept:
          parsed.hostname === 'api.github.com' && !parsed.pathname.includes('/releases/assets/')
            ? 'application/vnd.github+json'
            : 'application/octet-stream',
        'User-Agent': 'Disk-Watch',
        ...(parsed.hostname === 'api.github.com' && process.env.DISK_WATCH_GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.DISK_WATCH_GITHUB_TOKEN}` }
          : {}),
      },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Release redirect has no location.')
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Release download failed: HTTP ${response.status}.${response.status === 404 && !process.env.DISK_WATCH_GITHUB_TOKEN ? ' This repository may be private. Provide DISK_WATCH_GITHUB_TOKEN with contents read access when starting Disk Watch.' : ''}`,
      )
    }
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel()
      throw new Error('Release download exceeds the size limit.')
    }
    if (!response.body) throw new Error('Release download was empty.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new Error('Release download exceeds the size limit.')
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    }
    return Buffer.concat(chunks, size)
  }
  throw new Error('Too many release download redirects.')
}

export async function getRelease(version?: string): Promise<Release> {
  if (version !== undefined && !versionPattern.test(version)) throw new Error('Invalid stable release version.')
  const metadata = JSON.parse(
    (await fetchBytes(version ? `${api}/tags/v${version}` : `${api}/latest`, MAX_METADATA)).toString('utf8'),
  )
  const tag = metadata.tag_name
  if (
    metadata.draft !== false ||
    metadata.prerelease !== false ||
    typeof tag !== 'string' ||
    !tag.startsWith('v') ||
    !versionPattern.test(tag.slice(1)) ||
    (version !== undefined && tag !== `v${version}`)
  )
    throw new Error('GitHub did not return the requested stable release.')
  const resolved = tag.slice(1)
  const expected = [...releaseAssetNames(resolved), 'SHA256SUMS']
  if (!Array.isArray(metadata.assets) || metadata.assets.length !== expected.length)
    throw new Error('Release has an incomplete or unexpected asset set.')
  const assets: Record<string, string> = {}
  const assetIds: Record<string, number> = {}
  for (const asset of metadata.assets) {
    if (
      !expected.includes(asset.name) ||
      Object.hasOwn(assets, asset.name) ||
      asset.state !== 'uploaded' ||
      asset.browser_download_url !== `${downloads}${tag}/${asset.name}`
    )
      throw new Error('Release asset does not match the fixed repository and version.')
    assets[asset.name] = asset.browser_download_url
    if (Number.isSafeInteger(asset.id) && asset.id > 0) assetIds[asset.name] = asset.id
  }
  return { version: resolved, assets, assetIds }
}

export function parseChecksums(contents: string, version: string): Map<string, string> {
  const expected = releaseAssetNames(version)
  const result = new Map<string, string>()
  for (const line of contents.trim().split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64}) [ *]([^/\\\r\n]+)$/.exec(line)
    if (!match || !expected.includes(match[2]!) || result.has(match[2]!))
      throw new Error('Invalid release checksum manifest.')
    result.set(match[2]!, match[1]!.toLowerCase())
  }
  if (result.size !== expected.length) throw new Error('Release checksum manifest is incomplete.')
  return result
}

export async function downloadReleaseAsset(release: Release, name: string): Promise<Buffer> {
  if (!releaseAssetNames(release.version).includes(name)) throw new Error('Unsupported release asset.')
  const prefix = `${downloads}v${release.version}/`
  for (const file of [name, 'SHA256SUMS'])
    if (release.assets[file] !== `${prefix}${file}`) throw new Error('Invalid release asset URL.')
  const assetUrl = (file: string) => {
    if (!process.env.DISK_WATCH_GITHUB_TOKEN) return `${prefix}${file}`
    const id = release.assetIds?.[file]
    if (!Number.isSafeInteger(id) || !id || id < 1)
      throw new Error('Release asset ID is missing. Check the release again.')
    return `${api}/assets/${id}`
  }
  const manifest = parseChecksums(
    (await fetchBytes(assetUrl('SHA256SUMS'), MAX_METADATA)).toString('utf8'),
    release.version,
  )
  const contents = await fetchBytes(assetUrl(name), MAX_ASSET)
  const actual = createHash('sha256').update(contents).digest()
  if (!timingSafeEqual(actual, Buffer.from(manifest.get(name)!, 'hex')))
    throw new Error(`SHA256 verification failed for ${name}. The installed app was not changed.`)
  return contents
}
