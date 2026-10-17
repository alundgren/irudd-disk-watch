import type { ScanSummary } from './types'

export const DELETE_SCAN_MAX_AGE_MS = 60 * 60 * 1000

/** Start time is conservative: a long scan may already be too old when it finishes. */
export function isScanFreshForDeletion(
  scan: Pick<ScanSummary, 'startedAt' | 'status'> | null | undefined,
  now = Date.now(),
): boolean {
  return (
    !!scan &&
    scan.status === 'complete' &&
    Number.isFinite(scan.startedAt) &&
    Number.isFinite(now) &&
    scan.startedAt <= now &&
    now - scan.startedAt <= DELETE_SCAN_MAX_AGE_MS
  )
}
