import type { SearchRow, StagedDelete } from '../../shared/types'
import { summarizeStaged } from './deleteQueue'

/** Native deletion accepts at most this many top-level targets in one run. */
export const QUEUE_LIMIT = 1000

export interface SkippedItem {
  nodeId: number
  path: string
  reason: string
}

export interface BulkPlan {
  /** Selected rows that will be sent to staging, largest first. */
  queue: SearchRow[]
  skipped: SkippedItem[]
  size: number
  /** Queued items inside a selected folder. They merge into that folder. */
  absorbed: number
}

export interface BulkOutcome {
  queued: number
  skipped: SkippedItem[]
}

export const TOP_LEVEL_REASON = 'Root or top-level item. Only items at least two levels deep can be deleted.'
export const LIMIT_REASON = `The deletion queue holds at most ${QUEUE_LIMIT.toLocaleString('en-US')} items.`

/** Display-label containment. Staging repeats this check with exact native components. */
export function labelContains(parent: string, child: string, windows: boolean): boolean {
  const separator = windows ? '\\' : '/'
  const [a, b] = windows ? [parent.toLowerCase(), child.toLowerCase()] : [parent, child]
  return a === b || b.startsWith(a.endsWith(separator) ? a : a + separator)
}

/**
 * Decides what the confirm dialog offers before anything is staged. `blocked`
 * names why this root cannot queue deletions at all.
 */
export function planBulkQueue(
  rows: readonly SearchRow[],
  queue: readonly StagedDelete[],
  blocked: string | null,
  windows: boolean,
): BulkPlan {
  const skipped: SkippedItem[] = []
  const accepted: SearchRow[] = []
  const top = summarizeStaged([...queue]).top
  const absorbedItems = new Set<StagedDelete>()
  for (const row of [...rows].sort((a, b) => b.size - a.size)) {
    const skip = (reason: string) => skipped.push({ nodeId: row.nodeId, path: row.path, reason })
    if (blocked) {
      skip(blocked)
      continue
    }
    if (row.depth < 2) {
      skip(TOP_LEVEL_REASON)
      continue
    }
    const holder = queue.find((item) => item.nodeId === row.nodeId || labelContains(item.path, row.path, windows))
    if (holder) {
      skip(holder.nodeId === row.nodeId ? 'Already queued.' : `Already queued inside ${holder.path}.`)
      continue
    }
    const inside = top.filter((item) => labelContains(row.path, item.path, windows))
    const absorbedAfter = absorbedItems.size + inside.filter((item) => !absorbedItems.has(item)).length
    if (top.length - absorbedAfter + accepted.length + 1 > QUEUE_LIMIT) {
      skip(LIMIT_REASON)
      continue
    }
    for (const item of inside) absorbedItems.add(item)
    accepted.push(row)
  }
  return {
    queue: accepted,
    skipped,
    size: accepted.reduce((sum, row) => sum + row.size, 0),
    absorbed: queue.filter((item) => accepted.some((row) => labelContains(row.path, item.path, windows))).length,
  }
}

/** Electron prefixes errors that cross IPC; the dialog shows the store's own sentence. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
