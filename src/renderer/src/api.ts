import { isScanFreshForDeletion } from '../../shared/scanFreshness'
import type { Disk, DiskWatchApi, ScanSummary } from '../../shared/types'

declare global {
  interface Window {
    diskWatch: DiskWatchApi
  }
}

export const api = window.diskWatch

export const isWindows = (disk: Disk) => (disk.targetOS ?? disk.machine?.os ?? 'windows') === 'windows'
export const isHistorical = (disk: Disk) => disk.machine?.kind === 'historical'
export const canCleanup = (disk: Disk) => !isHistorical(disk) && (isWindows(disk) || disk.cleanupEnabled === true)
export function cleanupScanProblem(disk: Disk, now = Date.now()): string | null {
  return disk.latestScan?.diskId === disk.id && isScanFreshForDeletion(disk.latestScan, now)
    ? null
    : 'Scan this root again before deleting. Deletion requires a completed scan started within the last hour.'
}
export const machineLabel = (disk: Disk) => disk.machine?.name ?? 'This computer'

/** Labels only. Native file operations use node IDs and encoded components. */
export function joinDisplayPath(disk: Disk, parent: string, name: string): string {
  const separator = isWindows(disk) ? '\\' : '/'
  return `${parent.endsWith(separator) ? parent.slice(0, -1) : parent}${separator}${name}`
}

const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Uses 1024-based units, as Explorer does. */
export function formatBytes(bytes: number): string {
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${bytes < 0 ? '-' : ''}${value.toFixed(digits)} ${units[unit]}`
}

export function formatDelta(bytes: number): string {
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes)
}

export const formatCount = (n: number) => n.toLocaleString('en-US')

export function formatWhen(time: number): string {
  return new Date(time).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function describeScan(scan: ScanSummary): string {
  return `${formatWhen(scan.startedAt)} · ${formatBytes(scan.size)}${scan.coverage === 'partial' ? ' · partial coverage' : ''}`
}
