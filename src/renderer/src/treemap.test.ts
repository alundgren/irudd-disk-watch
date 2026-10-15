import { describe, expect, it } from 'vite-plus/test'
import type { TreeRow } from '../../shared/types'
import { mapEntries, treemap } from './treemap'

describe('treemap', () => {
  it('fills the canvas without overlaps and preserves byte proportions at different aspect ratios', () => {
    const items = [65, 24, 13, 9, 4, 2, 1, 0.01].map((size) => ({ size }))
    const total = items.reduce((sum, item) => sum + item.size, 0)
    for (const [width, height] of [
      [900, 500],
      [320, 900],
      [30, 30],
    ]) {
      const boxes = treemap(items, width!, height!)
      expect(boxes).toHaveLength(items.length)
      for (const box of boxes) {
        expect((box.width * box.height) / (width! * height!)).toBeCloseTo(box.item.size / total, 10)
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width! + 1e-8)
        expect(box.y + box.height).toBeLessThanOrEqual(height! + 1e-8)
        for (const other of boxes.filter((other) => other !== box)) {
          const overlapWidth = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
          const overlapHeight = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
          expect(overlapWidth <= 1e-8 || overlapHeight <= 1e-8).toBe(true)
        }
      }
    }
  })

  it('handles empty scans, zero sizes and an unmeasured canvas', () => {
    expect(treemap([], 500, 300)).toEqual([])
    expect(treemap([{ size: 0 }, { size: -1 }, { size: NaN }], 500, 300)).toEqual([])
    expect(treemap([{ size: 10 }], 0, 300)).toEqual([])
  })

  it('bounds rendered entries while keeping every byte and remaining item accessible', () => {
    const rows: TreeRow[] = Array.from({ length: 10000 }, (_, nodeId) => ({
      nodeId,
      size: nodeId + 1,
      name: `file-${nodeId}`,
      kind: 'file',
      files: 1,
      createdAt: null,
      lastWrittenAt: null,
    }))
    const entries = mapEntries(rows)
    expect(entries).toHaveLength(80)
    expect(entries.reduce((sum, entry) => sum + entry.size, 0)).toBe(rows.reduce((sum, row) => sum + row.size, 0))
    expect(entries.at(-1)!.grouped).toHaveLength(9921)
    expect(entries[0]!.row!.nodeId).toBe(9999)
    expect(rows[0]!.nodeId).toBe(0)
  })
})
