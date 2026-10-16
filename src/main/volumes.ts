import type { NativeRoot, NativeVolume, TargetOS, VolumeDiscovery } from '../shared/types'
import { bytes, count, object, textField } from '../shared/workerProtocol.ts'
import { canonicalPath, pathKey, unixLabel } from '../shared/paths.ts'

export function absoluteFolderPath(path: unknown, os: TargetOS): string {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Enter an absolute folder path.')
  if (os === 'windows') canonicalPath(path)
  else if (!path.startsWith('/')) throw new Error('Enter an absolute folder path starting with /.')
  return path
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('Invalid volume observation identity.')
  return value
}

export function volumeDiscovery(value: unknown, os: TargetOS): VolumeDiscovery {
  const result = object(value)
  count(result.observedAt, 'volume observation time')
  count(result.errors, 'volume discovery errors')
  if (typeof result.truncated !== 'boolean' || !Array.isArray(result.volumes) || result.volumes.length > 1024)
    throw new Error('Invalid mounted volume list.')
  const ids = new Set<string>()
  for (const value of result.volumes) {
    const row = object(value)
    const id = textField(row.id, 'volume ID')
    if (!id || ids.has(id)) throw new Error('Duplicate or empty volume ID.')
    ids.add(id)
    textField(row.name, 'volume name')
    const path = textField(row.path, 'volume path')
    if (row.os !== os || !['local', 'network', 'removable', 'system'].includes(String(row.kind)))
      throw new Error('Invalid volume platform or kind.')
    if (row.filesystem !== null) textField(row.filesystem, 'volume filesystem')
    if (!(row.readOnly === null || typeof row.readOnly === 'boolean') || typeof row.recommended !== 'boolean')
      throw new Error('Invalid volume access flags.')
    if (row.mount !== undefined) identity(row.mount)
    if (row.device !== undefined) identity(row.device)
    if (os !== 'windows') {
      const raw = bytes(row.pathBytes)
      const buffer = Buffer.from(raw, 'base64')
      const label = buffer
        .toString('latin1')
        .split('/')
        .map((part) => (part ? unixLabel(Buffer.from(part, 'latin1').toString('base64')) : ''))
        .join('/')
      if (buffer[0] !== 47 || label !== path) throw new Error('Invalid native volume path.')
      identity(row.mount)
    } else absoluteFolderPath(path, os)
    if (row.capacity !== null) {
      const capacity = object(row.capacity)
      count(capacity.total, 'volume capacity')
      count(capacity.free, 'volume free capacity')
      if ((capacity.free as number) > (capacity.total as number)) throw new Error('Invalid volume free capacity.')
    }
  }
  return result as unknown as VolumeDiscovery
}

export function selectedVolume(volumes: NativeVolume[], candidate: NativeVolume): NativeVolume {
  const saved = volumes.find((volume) => volume.id === candidate?.id)
  if (
    !saved ||
    Object.keys(saved).some(
      (key) =>
        JSON.stringify(saved[key as keyof NativeVolume]) !== JSON.stringify(candidate[key as keyof NativeVolume]),
    )
  )
    throw new Error('The drive list changed. Refresh the list and choose again.')
  if (saved.mount === undefined && saved.device === undefined)
    throw new Error('This drive has no cached identity. Inspect its path using the custom folder option.')
  return saved
}

export function verifyVolume(volume: NativeVolume, root: NativeRoot): void {
  if (
    (volume.mount !== undefined && volume.mount !== root.identity.mount) ||
    (volume.device !== undefined && volume.device !== root.identity.device)
  )
    throw new Error('This drive was unmounted or replaced. Refresh the drive list and choose again.')
  if (volume.os !== 'windows' && volume.pathBytes !== root.pathBytes)
    throw new Error('The inspected drive path changed. Refresh the drive list and choose again.')
  if (volume.os === 'windows' && pathKey(volume.path) !== pathKey(root.path))
    throw new Error(
      'This drive mapping resolves to a different folder. Inspect its path using the custom folder option.',
    )
}
