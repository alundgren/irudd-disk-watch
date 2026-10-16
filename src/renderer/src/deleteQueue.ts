import { pathKey } from '../../shared/paths'
import type { ScanSummary, StagedDelete } from '../../shared/types'

const ancestry = new WeakMap<StagedDelete, string[]>()

/**
 * Keys of a target and every containing folder, outermost first. Native targets
 * compare machine and encoded components; Windows targets compare folded paths.
 * Cached per object because queues hold up to a thousand targets.
 */
function targetKeys(item: StagedDelete): string[] {
  let keys = ancestry.get(item)
  if (!keys) {
    if (item.components) {
      // Base64 components never contain a colon.
      const prefix = `u:${item.machineId ?? ''}`
      keys = item.components.map((_, index) => `${prefix}:${item.components!.slice(0, index + 1).join(':')}`)
    } else {
      const key = pathKey(item.path)
      keys = [...key.matchAll(/\\/g)].map((match) => `w:${key.slice(0, match.index)}`).concat(`w:${key}`)
    }
    ancestry.set(item, keys)
  }
  return keys
}
const ownKey = (item: StagedDelete) => targetKeys(item).at(-1)!

export function sameTarget(a: StagedDelete, b: StagedDelete) {
  return ownKey(a) === ownKey(b)
}
export function containsTarget(parent: StagedDelete, child: StagedDelete) {
  return targetKeys(child).includes(ownKey(parent))
}
export function summarizeStaged(items: StagedDelete[]) {
  const queued = new Set(items.map(ownKey))
  const top = items.filter(
    (item) =>
      !targetKeys(item)
        .slice(0, -1)
        .some((key) => queued.has(key)),
  )
  return {
    items,
    top,
    size: top.reduce((sum, item) => sum + item.size, 0),
    files: top.reduce((sum, item) => sum + item.files, 0),
    partial: top.some((item) => item.partialScan),
  }
}

/** Top-level queue targets, updated one addition at a time for bulk queueing. */
export class QueueIndex {
  private top = new Map<string, StagedDelete>()
  constructor(items: StagedDelete[]) {
    for (const item of summarizeStaged(items).top) this.top.set(ownKey(item), item)
  }
  get size() {
    return this.top.size
  }
  /** The queued target that equals or contains `target`, if any. */
  holder(target: StagedDelete): StagedDelete | undefined {
    for (const key of targetKeys(target)) {
      const found = this.top.get(key)
      if (found) return found
    }
    return undefined
  }
  /**
   * Adds a target no queued item holds. Queued targets inside it stop counting as
   * top-level. Returns false, changing nothing, when the result would exceed `limit`.
   */
  add(target: StagedDelete, limit: number): boolean {
    const key = ownKey(target)
    const inside = [...this.top].filter(([, item]) => targetKeys(item).includes(key))
    if (this.top.size - inside.length + 1 > limit) return false
    for (const [other] of inside) this.top.delete(other)
    this.top.set(key, target)
    return true
  }
}

/**
 * Start time of the newest finished scan of a Unix root. Deletions created before it no
 * longer block staging. Partial scans count too: a root such as `/` always has unreadable
 * items, and the native worker checks every target identity again before deleting.
 */
export function verifiedScanTime(scans: ScanSummary[]) {
  // Same choice as the main process: the finished Unix scan with the highest ID.
  const latest = scans
    .filter((scan) => scan.status === 'complete')
    .reduce<ScanSummary | null>((best, scan) => (!best || scan.id > best.id ? scan : best), null)
  return latest?.startedAt ?? 0
}
