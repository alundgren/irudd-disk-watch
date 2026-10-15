import type { NativeVolume } from '../../shared/types'

export function canTrackVolume(volume: NativeVolume): boolean {
  if (volume.os !== 'windows') return !!volume.pathBytes && !!volume.mount
  if (!volume.mount && !volume.device) return false
  return /^[a-z]:\\/i.test(volume.path) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/.test(volume.path)
}

export function volumeChoices(volumes: NativeVolume[], showSystem: boolean): NativeVolume[] {
  return volumes
    .filter((volume) => showSystem || volume.kind !== 'system')
    .sort(
      (a, b) =>
        Number(isMacData(b)) - Number(isMacData(a)) ||
        Number(b.recommended) - Number(a.recommended) ||
        a.name.localeCompare(b.name),
    )
}

export function volumeExplanation(volume: NativeVolume): string | null {
  if (volume.os === 'macos' && volume.path === '/')
    return 'macOS system volume. This does not include Data, where apps and your files are stored.'
  if (isMacData(volume)) return 'Apps and your files'
  return null
}

function isMacData(volume: NativeVolume): boolean {
  return volume.os === 'macos' && volume.path === '/System/Volumes/Data'
}
