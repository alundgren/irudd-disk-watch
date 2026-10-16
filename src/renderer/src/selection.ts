/** Row selection for the filtered Space list. Rows are identified by node ID, ranges by list position. */
export interface Selection {
  ids: ReadonlySet<number>
  /** Position that Shift-click and Shift+arrow ranges start from. */
  anchor: number | null
}

export const emptySelection: Selection = { ids: new Set(), anchor: null }

export interface Modifiers {
  shift?: boolean
  /** Cmd on macOS, Ctrl elsewhere. */
  toggle?: boolean
}

function range(order: readonly number[], from: number, to: number): number[] {
  const [start, end] = from <= to ? [from, to] : [to, from]
  return order.slice(Math.max(0, start), end + 1)
}

/** Click selects one row, Cmd/Ctrl toggles one row, Shift selects from the anchor; both add the range. */
export function clickSelection(
  current: Selection,
  order: readonly number[],
  index: number,
  mods: Modifiers,
): Selection {
  const id = order[index]
  if (id === undefined) return current
  if (mods.shift && current.anchor !== null) {
    const ids = range(order, current.anchor, index)
    return { ids: new Set(mods.toggle ? [...current.ids, ...ids] : ids), anchor: current.anchor }
  }
  if (mods.toggle) {
    const ids = new Set(current.ids)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    return { ids, anchor: index }
  }
  return { ids: new Set([id]), anchor: index }
}

export function selectAll(order: readonly number[]): Selection {
  return { ids: new Set(order), anchor: order.length ? 0 : null }
}

/** Keeps only rows still listed, for example after a new search. */
export function pruneSelection(current: Selection, order: readonly number[]): Selection {
  const listed = new Set(order)
  const ids = [...current.ids].filter((id) => listed.has(id))
  if (ids.length === current.ids.size && (current.anchor === null || current.anchor < order.length)) return current
  return {
    ids: new Set(ids),
    anchor: ids.length && current.anchor !== null && current.anchor < order.length ? current.anchor : null,
  }
}

/** Pointer travel before a press on a row becomes a rectangle selection instead of a click. */
export const DRAG_THRESHOLD = 4

export interface Point {
  x: number
  y: number
}

export const isDrag = (start: Point, current: Point) =>
  Math.abs(current.x - start.x) > DRAG_THRESHOLD || Math.abs(current.y - start.y) > DRAG_THRESHOLD

/** Rectangle between two points, normalized so width and height are positive. */
export function band(start: Point, current: Point) {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  }
}

/**
 * Rows touched by a vertical drag. Rows span the full list width, so only their
 * vertical extent matters. `rows` holds each row's top and bottom in the same
 * coordinates as the points.
 */
export function rowsInBand(rows: readonly { top: number; bottom: number }[], start: Point, current: Point): number[] {
  const top = Math.min(start.y, current.y)
  const bottom = Math.max(start.y, current.y)
  const hits: number[] = []
  rows.forEach((row, index) => {
    if (row.bottom > top && row.top <= bottom) hits.push(index)
  })
  return hits
}

/**
 * Selection while dragging. With Cmd/Ctrl held the rectangle adds to the selection
 * from before the drag. The row under the press becomes the Shift-click anchor.
 */
export function dragSelection(
  before: Selection,
  order: readonly number[],
  hits: readonly number[],
  additive: boolean,
  startIndex: number | null,
): Selection {
  const ids = hits.map((index) => order[index]).filter((id) => id !== undefined)
  return { ids: new Set(additive ? [...before.ids, ...ids] : ids), anchor: startIndex ?? before.anchor }
}
