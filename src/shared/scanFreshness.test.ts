import { expect, test } from 'vite-plus/test'
import { DELETE_SCAN_MAX_AGE_MS, isScanFreshForDeletion } from './scanFreshness'

const now = 10_000_000
const scan = { status: 'complete' as const, startedAt: now - DELETE_SCAN_MAX_AGE_MS }

test('deletion accepts exactly one hour from the start, and rejects expiry even one millisecond later', () => {
  expect(isScanFreshForDeletion(scan, now)).toBe(true)
  expect(isScanFreshForDeletion(scan, now + 1)).toBe(false)
  expect(isScanFreshForDeletion({ ...scan, startedAt: now }, now)).toBe(true)
})

test('missing, invalid, future and unfinished scans cannot authorize deletion', () => {
  for (const value of [
    null,
    undefined,
    { ...scan, startedAt: NaN },
    { ...scan, startedAt: Infinity },
    { ...scan, startedAt: -Infinity },
    { ...scan, startedAt: now + 1 },
    { ...scan, startedAt: undefined as unknown as number },
  ]) {
    expect(isScanFreshForDeletion(value, now)).toBe(false)
  }
  for (const status of ['running', 'cancelled', 'failed'] as const)
    expect(isScanFreshForDeletion({ startedAt: now, status }, now)).toBe(false)
  expect(isScanFreshForDeletion(scan, NaN)).toBe(false)
})
