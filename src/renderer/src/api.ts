import type { DiskWatchApi, ScanSummary } from '../../shared/types'

declare global {
  interface Window {
    diskWatch: DiskWatchApi
  }
}

export const api = window.diskWatch

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
  return `${formatWhen(scan.startedAt)} · ${formatBytes(scan.size)}`
}
