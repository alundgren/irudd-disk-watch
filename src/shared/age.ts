const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Ages are elapsed durations; month and year use 30 and 365 days. */
export function formatAge(timestamp: number | null | undefined, now: number): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) return ''
  const elapsed = now - timestamp
  for (const [unit, duration] of [
    ['y', 365 * DAY],
    ['mo', 30 * DAY],
    ['d', DAY],
    ['h', HOUR],
    ['m', MINUTE],
    ['s', SECOND],
  ] as const) {
    if (elapsed >= duration || unit === 's') return `${Math.floor(elapsed / duration)}${unit}`
  }
  return ''
}
