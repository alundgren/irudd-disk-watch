import { expect, test } from 'vite-plus/test'
import { formatAge } from './age'

test('elapsed ages stay compact across unit boundaries', () => {
  const now = 4_000_000_000_000
  for (const [elapsed, expected] of [
    [0, '0s'],
    [999, '0s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [3_599_999, '59m'],
    [3_600_000, '1h'],
    [86_399_999, '23h'],
    [86_400_000, '1d'],
    [30 * 86_400_000 - 1, '29d'],
    [30 * 86_400_000, '1mo'],
    [365 * 86_400_000, '1y'],
    [80 * 365 * 86_400_000, '80y'],
  ] as const)
    expect(formatAge(now - elapsed, now)).toBe(expected)
})

test('missing, invalid and future ages stay blank', () => {
  const now = 2_000_000_000_000
  for (const timestamp of [null, undefined, 0, -1, NaN, Infinity, now + 1]) expect(formatAge(timestamp, now)).toBe('')
})
