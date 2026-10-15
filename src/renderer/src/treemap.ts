import type { TreeRow } from '../../shared/types'

export interface Rectangle<T> {
  item: T
  x: number
  y: number
  width: number
  height: number
}

/** Squarified rows keep large entries readable while preserving their relative areas. */
export function treemap<T extends { size: number }>(items: T[], width: number, height: number): Rectangle<T>[] {
  const sorted = items.filter((item) => Number.isFinite(item.size) && item.size > 0).sort((a, b) => b.size - a.size)
  const total = sorted.reduce((sum, item) => sum + item.size, 0)
  if (total === 0 || width <= 0 || height <= 0) return []
  const result: Rectangle<T>[] = []
  let x = 0
  let y = 0
  let remaining = total
  let start = 0
  while (start < sorted.length) {
    const vertical = width >= height
    const side = vertical ? height : width
    const areaScale = (width * height) / remaining
    const worst = (sum: number, min: number, max: number) =>
      Math.max((side * side * max) / (sum * sum * areaScale), (sum * sum * areaScale) / (side * side * min))
    let end = start + 1
    let sum = sorted[start]!.size
    let score = worst(sum, sum, sum)
    while (end < sorted.length) {
      const next = sorted[end]!.size
      const candidate = worst(sum + next, next, sorted[start]!.size)
      if (candidate > score) break
      score = candidate
      sum += next
      end++
    }
    const thickness = end === sorted.length ? (vertical ? width : height) : (sum * areaScale) / side
    let offset = 0
    for (let i = start; i < end; i++) {
      const item = sorted[i]!
      const length = i === end - 1 ? side - offset : (item.size / sum) * side
      result.push({
        item,
        x: vertical ? x : x + offset,
        y: vertical ? y + offset : y,
        width: vertical ? thickness : length,
        height: vertical ? length : thickness,
      })
      offset += length
    }
    if (vertical) {
      x += thickness
      width = Math.max(0, width - thickness)
    } else {
      y += thickness
      height = Math.max(0, height - thickness)
    }
    remaining -= sum
    start = end
  }
  return result
}

export interface MapEntry {
  name: string
  size: number
  row?: TreeRow
  grouped?: TreeRow[]
}

export function mapEntries(rows: TreeRow[], limit = 80): MapEntry[] {
  const positive = rows.filter((row) => row.size > 0).sort((a, b) => b.size - a.size)
  const shown = positive.length > limit ? positive.slice(0, limit - 1) : positive
  const entries: MapEntry[] = shown.map((row) => ({
    name: row.kind === 'rest' ? 'Smaller files' : row.name,
    size: row.size,
    row,
  }))
  if (shown.length < positive.length) {
    const grouped = positive.slice(shown.length)
    entries.push({
      name: `${grouped.length.toLocaleString('en-US')} other items`,
      size: grouped.reduce((sum, row) => sum + row.size, 0),
      grouped,
    })
  }
  return entries
}
