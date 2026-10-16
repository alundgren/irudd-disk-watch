import { memo, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { SearchRow, TreeRow } from '../../shared/types'
import { LazyChildren } from './LazyTree'
import { NodeCells } from './NodeCells'
import { NodeIcon } from './NodeIcon'
import { openRowContext } from './rowContext'
import {
  band,
  clickSelection,
  dragSelection,
  emptySelection,
  isDrag,
  rowsInBand,
  selectAll,
  type Point,
  type Selection,
} from './selection'

interface FilteredListProps {
  rows: SearchRow[]
  /** Visible bytes of the scan, for the size bars. */
  visibleSize: number
  stagedIds: ReadonlySet<number>
  selection: Selection
  onSelect(selection: Selection): void
  reloadKey: string
  load(nodeId: number): Promise<TreeRow[]>
  renderChild(row: TreeRow, siblings: TreeRow[]): { name: ReactNode; cells: ReactNode }
  onContextMenu(row: TreeRow, event: MouseEvent, pathDepth: number): void
}

const toggleKey = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  navigator.platform.startsWith('Mac') ? event.metaKey : event.ctrlKey

/** Row callbacks that keep their identity across renders, so unchanged rows skip rendering. */
interface RowActions {
  click(index: number, event: MouseEvent): void
  keyDown(event: KeyboardEvent<HTMLDivElement>, row: SearchRow, index: number): void
  toggleOpen(nodeId: number, value?: boolean): void
  contextMenu(row: TreeRow, event: MouseEvent, pathDepth: number): void
}

/** Top-most filter matches with multi-select. Each match expands into its normal children. */
export function FilteredList(props: FilteredListProps) {
  const { rows, selection, onSelect } = props
  const order = useMemo(() => rows.map((row) => row.nodeId), [rows])
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [rectangle, setRectangle] = useState<ReturnType<typeof band> | null>(null)
  const dragged = useRef(false)
  const latest = useRef({ selection, order, onSelect, onContextMenu: props.onContextMenu })
  latest.current = { selection, order, onSelect, onContextMenu: props.onContextMenu }

  const focusRow = (index: number) =>
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${Math.max(0, Math.min(latest.current.order.length - 1, index))}"]`)
      ?.focus()

  const actions = useMemo<RowActions>(() => {
    const toggleOpen = (nodeId: number, value?: boolean) =>
      setOpen((was) => {
        const next = new Set(was)
        if (value ?? !next.has(nodeId)) next.add(nodeId)
        else next.delete(nodeId)
        return next
      })
    return {
      toggleOpen,
      click(index, event) {
        if (dragged.current) {
          dragged.current = false
          return
        }
        const { selection, order, onSelect } = latest.current
        onSelect(clickSelection(selection, order, index, { shift: event.shiftKey, toggle: toggleKey(event) }))
      },
      contextMenu: (row, event, pathDepth) => latest.current.onContextMenu(row, event, pathDepth),
      keyDown(event, row, index) {
        if (openRowContext(event)) return
        const { selection, order, onSelect } = latest.current
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = Math.max(0, Math.min(order.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          if (event.shiftKey) {
            const anchored =
              selection.anchor !== null && order.includes(selection.anchor)
                ? selection
                : { ...selection, anchor: row.nodeId }
            onSelect(clickSelection(anchored, order, next, { shift: true }))
          }
          focusRow(next)
        }
        if (event.key === ' ') {
          event.preventDefault()
          onSelect(clickSelection(selection, order, index, { toggle: true }))
        }
        if (row.kind !== 'dir') return
        if (event.key === 'Enter') {
          event.preventDefault()
          toggleOpen(row.nodeId)
        }
        if (event.key === 'ArrowRight') toggleOpen(row.nodeId, true)
        if (event.key === 'ArrowLeft') toggleOpen(row.nodeId, false)
      },
    }
  }, [])

  const startDrag = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const element = list.current
    if (event.button !== 0 || target.closest('button, input, a') || !element) return
    if (event.shiftKey) event.preventDefault()
    // Positions relative to the list stay valid while it scrolls, so rows are measured once.
    const relative = (x: number, y: number): Point => {
      const box = element.getBoundingClientRect()
      return { x: x - box.left, y: y - box.top }
    }
    const origin = element.getBoundingClientRect()
    const boxes = Array.from(element.querySelectorAll<HTMLElement>('[data-index]')).map((row) => {
      const box = row.getBoundingClientRect()
      return { top: box.top - origin.top, bottom: box.bottom - origin.top }
    })
    const start = relative(event.clientX, event.clientY)
    const before = latest.current.selection
    const order = latest.current.order
    const additive = toggleKey(event)
    const pressed = target.closest<HTMLElement>('[data-index]')
    const startId = pressed ? (order[Number(pressed.dataset.index)] ?? null) : null
    let pointer = { x: event.clientX, y: event.clientY }
    let dragging = false
    let frame = 0
    let shown = ''
    dragged.current = false
    const update = () => {
      frame = 0
      const point = relative(pointer.x, pointer.y)
      if (!dragging && !isDrag(start, point)) return
      dragging = true
      dragged.current = true
      const hits = rowsInBand(boxes, start, point)
      const key = hits.length ? `${hits[0]}-${hits.at(-1)}` : ''
      if (key !== shown) {
        shown = key
        latest.current.onSelect(dragSelection(before, order, hits, additive, startId))
      }
      setRectangle(band(start, point))
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(update)
    }
    const move = (moved: globalThis.MouseEvent) => {
      pointer = { x: moved.clientX, y: moved.clientY }
      schedule()
    }
    const up = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('scroll', schedule, true)
      setRectangle(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('scroll', schedule, true)
  }

  const listKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && selection.ids.size) {
      event.preventDefault()
      onSelect(emptySelection)
    }
    if (event.key.toLowerCase() === 'a' && toggleKey(event) && !event.shiftKey) {
      event.preventDefault()
      onSelect(selectAll(order))
    }
  }

  return (
    <div
      ref={list}
      className="tree filtered-tree"
      role="tree"
      aria-multiselectable="true"
      aria-label="Filter matches"
      onMouseDown={startDrag}
      onKeyDown={listKeys}
      onClick={(event) => {
        if (event.target === event.currentTarget && !dragged.current) onSelect(emptySelection)
      }}
    >
      {rows.map((row, index) => (
        <MatchRow
          key={row.nodeId}
          row={row}
          index={index}
          selected={selection.ids.has(row.nodeId)}
          expanded={open.has(row.nodeId)}
          staged={props.stagedIds.has(row.nodeId)}
          share={props.visibleSize > 0 ? row.size / props.visibleSize : 0}
          reloadKey={props.reloadKey}
          load={props.load}
          renderChild={props.renderChild}
          actions={actions}
        />
      ))}
      {rectangle && (
        <span
          className="select-band"
          aria-hidden
          style={{ left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height }}
        />
      )}
    </div>
  )
}

interface MatchRowProps {
  row: SearchRow
  index: number
  selected: boolean
  expanded: boolean
  staged: boolean
  share: number
  reloadKey: string
  load(nodeId: number): Promise<TreeRow[]>
  renderChild(row: TreeRow, siblings: TreeRow[]): { name: ReactNode; cells: ReactNode }
  actions: RowActions
}

const MatchRow = memo(function MatchRow({
  row,
  index,
  selected,
  expanded,
  staged,
  share,
  reloadKey,
  load,
  renderChild,
  actions,
}: MatchRowProps) {
  const split = row.path.length - row.name.length
  return (
    <div role="none">
      <div
        className={`tree-row match-row${selected ? ' selected' : ''}`}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={row.kind === 'dir' ? expanded : undefined}
        data-index={index}
        tabIndex={0}
        title={row.path}
        onClick={(event) => actions.click(index, event)}
        onDoubleClick={() => row.kind === 'dir' && actions.toggleOpen(row.nodeId)}
        onContextMenu={(event) => actions.contextMenu(row, event, row.depth)}
        onKeyDown={(event) => actions.keyDown(event, row, index)}
      >
        <span className="tree-name" style={{ paddingLeft: '14px' }}>
          {row.kind === 'dir' ? (
            <button
              className="chevron chevron-button"
              tabIndex={-1}
              aria-label={expanded ? 'Hide contents' : 'Show contents'}
              onClick={(event) => {
                event.stopPropagation()
                actions.toggleOpen(row.nodeId)
              }}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="chevron" aria-hidden />
          )}
          <span className={`name kind-${row.kind}${staged ? ' staged-row' : ''}`}>
            <NodeIcon kind={row.kind === 'dir' ? 'dir' : 'file'} />
            {/* The parent folder gives way first, from its start, so the matched name stays readable. */}
            <span className="node-name match-name">
              <span className="match-parent">
                <bdi dir="ltr">{row.path.slice(0, split)}</bdi>
              </span>
              <span className="match-leaf">{row.name}</span>
            </span>
            {staged && <span className="tag staged">queued</span>}
          </span>
        </span>
        <NodeCells row={row} share={share} shareLabel="of visible space" />
      </div>
      {expanded && (
        <LazyChildren<TreeRow>
          reloadKey={reloadKey}
          rootId={row.nodeId}
          depth={1}
          load={load}
          rowId={(child) => child.nodeId}
          canExpand={(child) => child.kind === 'dir'}
          emptyText="Empty folder"
          renderRow={renderChild}
          onContextMenu={(child, event, depth) => actions.contextMenu(child, event, row.depth + depth)}
        />
      )}
    </div>
  )
})
