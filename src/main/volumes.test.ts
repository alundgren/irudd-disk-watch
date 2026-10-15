import { expect, test } from 'vite-plus/test'
import type { NativeRoot, NativeVolume } from '../shared/types'
import { absoluteFolderPath, selectedVolume, verifyVolume, volumeDiscovery } from './volumes'

test('custom folders must be absolute on the execution OS before worker dispatch', () => {
  for (const input of ['', 'tmp', '~/tmp', '/tmp\0suffix']) expect(() => absoluteFolderPath(input, 'linux')).toThrow()
  for (const input of ['', 'tmp', 'C:tmp', '\\tmp', '/tmp', 'C:\\tmp\0suffix', '\\\\?\\C:\\tmp'])
    expect(() => absoluteFolderPath(input, 'windows')).toThrow()
  expect(absoluteFolderPath('/tmp/literal\\name', 'macos')).toBe('/tmp/literal\\name')
  expect(absoluteFolderPath('C:\\owned fixture', 'windows')).toBe('C:\\owned fixture')
  expect(absoluteFolderPath('\\\\host\\share\\fixture', 'windows')).toBe('\\\\host\\share\\fixture')
})

const pathBytes = Buffer.from([47, 109, 110, 116, 47, 255]).toString('base64')
const volume: NativeVolume = {
  id: 'snapshot-row',
  name: 'Data',
  path: '/mnt/\\xff',
  pathBytes,
  os: 'linux',
  filesystem: 'ext4',
  kind: 'local',
  readOnly: false,
  capacity: { total: 100, free: 10 },
  recommended: true,
  mount: '10',
  device: '20',
}
const root: NativeRoot = {
  path: volume.path,
  pathBytes,
  identity: { mount: '10', device: '20', inode: '2' },
  filesystem: 'ext4',
  readOnly: false,
  capacity: null,
  observedAt: 2,
}
const discovery = (volumes: unknown[]) => ({ observedAt: 1, volumes, errors: 0, truncated: false })

test('discovery preserves raw native paths and rejects malformed or ambiguous rows', () => {
  expect(volumeDiscovery(discovery([volume]), 'linux').volumes[0]?.pathBytes).toBe(pathBytes)
  for (const invalid of [
    { ...volume, pathBytes: undefined },
    { ...volume, mount: undefined },
    { ...volume, path: '/mnt/replacement' },
    { ...volume, device: 20 },
    { ...volume, os: 'macos' },
    { ...volume, capacity: { total: 1, free: 2 } },
  ])
    expect(() => volumeDiscovery(discovery([invalid]), 'linux')).toThrow()
  expect(() => volumeDiscovery(discovery([volume, volume]), 'linux')).toThrow(/Duplicate/)
  expect(() => volumeDiscovery(discovery(Array(1025).fill(volume)), 'linux')).toThrow()
})

test('registration requires saved discovery and refuses changed or replaced mounts', () => {
  expect(selectedVolume([volume], { ...volume })).toBe(volume)
  expect(() => selectedVolume([], volume)).toThrow(/Refresh/)
  expect(() => selectedVolume([volume], { ...volume, pathBytes: 'Lw==' })).toThrow(/Refresh/)
  expect(() => selectedVolume([volume], { ...volume, mount: '11' })).toThrow(/Refresh/)
  expect(() => verifyVolume(volume, { ...root, identity: { ...root.identity, mount: '11' } })).toThrow(/replaced/)
  expect(() => verifyVolume(volume, { ...root, identity: { ...root.identity, device: '21' } })).toThrow(/replaced/)
  expect(() => verifyVolume(volume, { ...root, pathBytes: 'Lw==' })).toThrow(/path changed/)
  verifyVolume(volume, root)
})

test('cache-only network rows keep unknown metadata and require deliberate path inspection on Windows', () => {
  const network: NativeVolume = {
    id: 'network',
    name: 'Mapped drive',
    path: 'Z:\\',
    os: 'windows',
    kind: 'network',
    readOnly: null,
    filesystem: null,
    capacity: null,
    recommended: false,
  }
  expect(volumeDiscovery(discovery([network]), 'windows').volumes).toEqual([network])
  expect(() => selectedVolume([network], network)).toThrow(/custom folder/)
  const cachedUnix = { ...volume, kind: 'network' as const, device: undefined, capacity: null }
  volumeDiscovery(discovery([cachedUnix]), 'linux')
  verifyVolume(cachedUnix, root)
})
