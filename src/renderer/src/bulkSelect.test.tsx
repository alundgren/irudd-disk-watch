import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { SearchRow, StagedDelete } from '../../shared/types'
import { errorText, LIMIT_REASON, planBulkQueue, QUEUE_LIMIT, TOP_LEVEL_REASON } from './bulkQueue'
import {
  clickSelection,
  dragSelection,
  emptySelection,
  isDrag,
  pruneSelection,
  rowsInBand,
  selectAll,
  type Selection,
} from './selection'

vi.stubGlobal('window', {
  diskWatch: new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error('Rendering must not start an operation.')
        }
      },
    },
  ),
})
const { BulkQueueDialog } = await import('./BulkQueueDialog')
const { filterQuery, matchSummary } = await import('./SpaceView')

const ids = (selection: Selection) => [...selection.ids].sort((a, b) => a - b)
const order = [10, 11, 12, 13, 14]

describe('row selection', () => {
  it('selects one row on click, toggles with Cmd/Ctrl and selects ranges from the anchor with Shift', () => {
    let selection = clickSelection(emptySelection, order, 1, {})
    expect(ids(selection)).toEqual([11])
    selection = clickSelection(selection, order, 3, { shift: true })
    expect(ids(selection)).toEqual([11, 12, 13])
    // A second Shift-click keeps the anchor and replaces the range.
    selection = clickSelection(selection, order, 0, { shift: true })
    expect(ids(selection)).toEqual([10, 11])
    selection = clickSelection(selection, order, 4, { toggle: true })
    expect(ids(selection)).toEqual([10, 11, 14])
    selection = clickSelection(selection, order, 10, {})
    expect(ids(selection)).toEqual([10, 11, 14])
    selection = clickSelection(selection, order, 1, { toggle: true })
    expect(ids(selection)).toEqual([10, 14])
    expect(selection.anchor).toBe(1)
    // Cmd/Ctrl+Shift adds the range to the selection.
    expect(ids(clickSelection(selection, order, 3, { shift: true, toggle: true }))).toEqual([10, 11, 12, 13, 14])
    expect(ids(clickSelection(emptySelection, order, 2, { shift: true }))).toEqual([12])
  })

  it('selects all rows and drops rows a new search no longer lists', () => {
    expect(ids(selectAll(order))).toEqual(order)
    expect(selectAll([]).anchor).toBeNull()
    const pruned = pruneSelection(selectAll(order), [12, 99])
    expect(ids(pruned)).toEqual([12])
    expect(pruneSelection(pruned, [12, 99])).toBe(pruned)
    expect(pruneSelection(pruned, [])).toEqual({ ids: new Set(), anchor: null })
  })
})

describe('rectangle selection', () => {
  const rows = [0, 46, 92, 138, 184].map((top) => ({ top, bottom: top + 46 }))

  it('waits for a few pixels of movement so clicks stay clicks', () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(false)
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 15 })).toBe(true)
    expect(isDrag({ x: 10, y: 10 }, { x: 5, y: 10 })).toBe(true)
  })

  it('selects every row the rectangle touches in either direction', () => {
    expect(rowsInBand(rows, { x: 0, y: 50 }, { x: 0, y: 100 })).toEqual([1, 2])
    expect(rowsInBand(rows, { x: 0, y: 100 }, { x: 0, y: 50 })).toEqual([1, 2])
    expect(rowsInBand(rows, { x: 0, y: 46 }, { x: 0, y: 47 })).toEqual([1])
    expect(rowsInBand(rows, { x: 0, y: 300 }, { x: 0, y: 400 })).toEqual([])
  })

  it('replaces the selection, or adds to it with Cmd/Ctrl, and anchors on the pressed row', () => {
    const before = clickSelection(emptySelection, order, 4, {})
    const replaced = dragSelection(before, order, [1, 2], false, 2)
    expect(ids(replaced)).toEqual([11, 12])
    expect(replaced.anchor).toBe(2)
    expect(ids(dragSelection(before, order, [1, 2], true, 2))).toEqual([11, 12, 14])
    expect(dragSelection(before, order, [], false, null)).toEqual({ ids: new Set(), anchor: 4 })
  })
})

const row = (nodeId: number, path: string, size: number, depth = path.split('/').length - 2): SearchRow => ({
  nodeId,
  path,
  name: path.split('/').at(-1)!,
  kind: 'dir',
  size,
  files: 1,
  createdAt: null,
  lastWrittenAt: null,
  depth,
})
const staged = (nodeId: number, path: string): StagedDelete => ({
  nodeId,
  path,
  scanId: 1,
  kind: 'dir',
  size: 5,
  files: 1,
  components: path.split('/').slice(2),
})

describe('bulk queue plan', () => {
  it('skips top-level, queued and covered items, merges queued children and sorts by size', () => {
    const rows = [
      row(1, '/root/top', 900),
      row(2, '/root/a/cache', 10),
      row(3, '/root/a/old', 20),
      row(4, '/root/b/inside/deeper', 30),
      row(5, '/root/c/logs', 40),
    ]
    const queue = [staged(2, '/root/a/cache'), staged(6, '/root/b/inside'), staged(7, '/root/c/logs/x')]
    const plan = planBulkQueue(rows, queue, null, false)
    expect(plan.queue.map((item) => item.nodeId)).toEqual([5, 3])
    expect(plan.size).toBe(60)
    expect(plan.absorbed).toBe(1)
    expect(plan.skipped).toEqual([
      { nodeId: 1, path: '/root/top', reason: TOP_LEVEL_REASON },
      { nodeId: 4, path: '/root/b/inside/deeper', reason: 'Already queued inside /root/b/inside.' },
      { nodeId: 2, path: '/root/a/cache', reason: 'Already queued.' },
    ])
  })

  it('does not treat a sibling with a shared prefix as covered, and folds Windows case', () => {
    const plan = planBulkQueue([row(1, '/root/a/cache-old', 1)], [staged(2, '/root/a/cache')], null, false)
    expect(plan.queue).toHaveLength(1)
    const windows = { ...row(3, 'C:\\Users\\Me\\Temp', 1), depth: 3 }
    expect(planBulkQueue([windows], [staged(4, 'c:\\users\\me')], null, true).skipped[0]!.reason).toBe(
      'Already queued inside c:\\users\\me.',
    )
  })

  it('skips everything with the root reason when deletion is unavailable', () => {
    const plan = planBulkQueue([row(1, '/root/a/b', 1), row(2, '/root/a/c', 2)], [], 'Deletion is off.', false)
    expect(plan.queue).toEqual([])
    expect(plan.skipped.map((item) => item.reason)).toEqual(['Deletion is off.', 'Deletion is off.'])
  })

  it('keeps the largest items within the queue limit after counting queued items and merges', () => {
    const queue = Array.from({ length: QUEUE_LIMIT - 2 }, (_, index) => staged(10_000 + index, `/root/q/${index}`))
    const rows = [row(1, '/root/x/a', 3), row(2, '/root/x/b', 2), row(3, '/root/x/c', 1)]
    const plan = planBulkQueue(rows, queue, null, false)
    expect(plan.queue.map((item) => item.nodeId)).toEqual([1, 2])
    expect(plan.skipped).toEqual([{ nodeId: 3, path: '/root/x/c', reason: LIMIT_REASON }])
    // Selecting the folder that holds two queued items frees their places.
    const merged = planBulkQueue([row(4, '/root/q', 9, 1), ...rows], queue, null, false)
    expect(merged.skipped.find((item) => item.nodeId === 4)?.reason).toBe(TOP_LEVEL_REASON)
    const holder = planBulkQueue(
      [{ ...row(5, '/root/q/0', 9), depth: 2 }, ...rows],
      [...queue.slice(0, 1).map((item) => ({ ...item, path: '/root/q/0/inner' })), ...queue.slice(1)],
      null,
      false,
    )
    expect(holder.queue.map((item) => item.nodeId)).toEqual([5, 1, 2])
  })

  it('shows the store’s refusal text without the IPC prefix', () => {
    expect(
      errorText(
        new Error("Error invoking remote method 'stageDelete': Error: 2 items at or under this path could not be read"),
      ),
    ).toBe('2 items at or under this path could not be read')
    expect(errorText('plain')).toBe('plain')
  })
})

describe('confirm dialog', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, `/root/folder/item-${index + 1}`, 1024))
  const render = (plan: Parameters<typeof BulkQueueDialog>[0]['plan']) =>
    renderToStaticMarkup(
      <BulkQueueDialog plan={plan} onQueue={async () => ({ queued: 0, skipped: [] })} onClose={() => {}} />,
    )

  it('lists the count, total size, the first ten paths, skipped reasons and the rescan warning', () => {
    const html = render({
      queue: rows,
      size: 12 * 1024,
      absorbed: 2,
      skipped: [{ nodeId: 99, path: '/root/top', reason: TOP_LEVEL_REASON }],
    })
    expect(html).toContain('Queue 12 items for deletion')
    expect(html).toContain('12.0 KB')
    expect(html).toContain('/root/folder/item-10')
    expect(html).not.toContain('/root/folder/item-11')
    expect(html).toContain('and 2 items more')
    expect(html).toContain('Skipped 1 item')
    expect(html).toContain('/root/top')
    expect(html).toContain(TOP_LEVEL_REASON)
    expect(html).toContain('2 items already in the queue are inside selected folders')
    expect(html).toContain('scan this root again before queueing more items')
    expect(html).toContain('Queue 12 items</button>')
  })

  it('offers only Close when nothing can be queued', () => {
    const html = render({
      queue: [],
      size: 0,
      absorbed: 0,
      skipped: [{ nodeId: 1, path: '/root/a/b', reason: 'Off.' }],
    })
    expect(html).toContain('Nothing to queue')
    expect(html).toContain('Off.')
    expect(html).toContain('Close</button>')
    expect(html).not.toContain('Cancel')
  })
})

describe('filters', () => {
  it('ignores empty or invalid ages and keeps the typed name literally', () => {
    expect(filterQuery({ name: '', days: '' })).toBeNull()
    expect(filterQuery({ name: '', days: '-3' })).toBeNull()
    expect(filterQuery({ name: '%_ ', days: '' })).toEqual({ nameContains: '%_ ', olderThanDays: undefined })
    expect(filterQuery({ name: '', days: '30' })).toEqual({ nameContains: undefined, olderThanDays: 30 })
  })

  it('names the cap when results are limited', () => {
    expect(matchSummary({ rows: [], total: 0 })).toBe('0 matches')
    expect(matchSummary({ rows: [row(1, '/root/a/b', 1)], total: 1 })).toBe('1 match')
    expect(matchSummary({ rows: Array(1000), total: 2500 })).toBe('Showing the largest 1,000 of 2,500 matches')
  })
})
