import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createHash } from 'node:crypto'
import { downloadReleaseAsset, getRelease, parseChecksums, releaseAssetNames, RELEASE_REPOSITORY } from './releases'

const version = '0.2.0'
const prefix = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/`
const names = releaseAssetNames(version)
const bytes = Buffer.from('verified fixture binary')
const hash = createHash('sha256').update(bytes).digest('hex')
const manifest = names.map((name) => `${hash}  ${name}`).join('\n')
const metadata = () => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [...names, 'SHA256SUMS'].map((name) => ({ name, state: 'uploaded', browser_download_url: prefix + name })),
})
const release = () => ({
  version,
  assets: Object.fromEntries([...names, 'SHA256SUMS'].map((name) => [name, prefix + name])),
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('release client', () => {
  it('resolves latest and exact stable versions using only the fixed repository', async () => {
    const mock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(metadata())))
    vi.stubGlobal('fetch', mock)
    expect((await getRelease()).version).toBe(version)
    expect((await getRelease(version)).version).toBe(version)
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${version}`,
    ])
    await expect(getRelease('../bad')).rejects.toThrow('Invalid')
    expect(mock).toHaveBeenCalledTimes(2)
  })
  it.each(['prerelease', 'foreign URL', 'duplicate', 'missing', 'wrong tag'])(
    'rejects %s metadata',
    async (failure) => {
      const meta = metadata()
      if (failure === 'prerelease') meta.prerelease = true
      if (failure === 'foreign URL') meta.assets[0]!.browser_download_url = 'https://evil.example/installer'
      if (failure === 'duplicate') meta.assets[0] = meta.assets[1]!
      if (failure === 'missing') meta.assets.pop()
      if (failure === 'wrong tag') meta.tag_name = 'v0.3.0'
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(meta))),
      )
      await expect(getRelease(version)).rejects.toThrow()
    },
  )
  it('verifies matching raw worker bytes and rejects a changed candidate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(url.endsWith('SHA256SUMS') ? manifest : bytes)),
    )
    expect(await downloadReleaseAsset(release(), 'dw-scan-linux-arm64')).toEqual(bytes)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(url.endsWith('SHA256SUMS') ? manifest : 'tampered')),
    )
    await expect(downloadReleaseAsset(release(), names[0]!)).rejects.toThrow('SHA256')
  })
  it('refuses arbitrary assets, altered release objects, external redirects and oversized downloads', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(downloadReleaseAsset(release(), '../x')).rejects.toThrow('Unsupported')
    const changed = release()
    changed.assets[names[0]!] = 'https://evil.example/app'
    await expect(downloadReleaseAsset(changed, names[0]!)).rejects.toThrow('URL')
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/app' } }))
    await expect(getRelease()).rejects.toThrow('outside GitHub')
    fetcher.mockResolvedValue(new Response('large', { headers: { 'content-length': '9999999999' } }))
    await expect(getRelease()).rejects.toThrow('size limit')
  })
  it('enforces a streaming byte limit when content-length is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024 + 1))
                controller.close()
              },
            }),
          ),
      ),
    )
    await expect(getRelease()).rejects.toThrow('size limit')
  })
  it('accepts a GitHub CDN redirect with a timeout signal and rejects HTTP failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/asset' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata())))
    vi.stubGlobal('fetch', fetcher)
    expect((await getRelease()).version).toBe(version)
    expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
    fetcher.mockResolvedValue(new Response(null, { status: 503 }))
    await expect(getRelease()).rejects.toThrow('HTTP 503')
  })
  it('requires the exact manifest asset set without duplicates, paths or invalid hashes', () => {
    expect(parseChecksums(manifest, version).size).toBe(4)
    for (const invalid of [
      manifest + '\n' + manifest,
      manifest.split('\n').slice(1).join('\n'),
      manifest.replace(names[0]!, '../app'),
      manifest.replace(hash, 'bad'),
    ])
      expect(() => parseChecksums(invalid, version)).toThrow()
  })
})

it('authenticates private release downloads through fixed asset IDs without sending the token to the CDN', async () => {
  vi.stubEnv('DISK_WATCH_GITHUB_TOKEN', 'test-token')
  const result = release() as ReturnType<typeof release> & { assetIds: Record<string, number> }
  result.assetIds = Object.fromEntries([...names, 'SHA256SUMS'].map((name, i) => [name, i + 1]))
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(manifest))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/candidate' },
      }),
    )
    .mockResolvedValueOnce(new Response(bytes))
  vi.stubGlobal('fetch', fetcher)
  expect(await downloadReleaseAsset(result, names[0]!)).toEqual(bytes)
  expect(fetcher.mock.calls[0]![0]).toBe(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/assets/5`)
  expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe('Bearer test-token')
  expect(fetcher.mock.calls[1]![1].headers.Accept).toBe('application/octet-stream')
  expect(fetcher.mock.calls[2]![1].headers.Authorization).toBeUndefined()
})
