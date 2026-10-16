import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
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

/** Top-most filter matches with multi-select. Each match expands into its normal children. */
export function FilteredList(props: FilteredListProps) {
  const { rows, selection, onSelect } = props
  const order = rows.map((row) => row.nodeId)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const [rectangle, setRectangle] = useState<ReturnType<typeof band> | null>(null)
  const dragged = useRef(false)
  const current = useRef(selection)
  current.current = selection

  const toggleOpen = (nodeId: number, value?: boolean) =>
    setOpen((was) => {
      const next = new Set(was)
      if (value ?? !next.has(nodeId)) next.add(nodeId)
      else next.delete(nodeId)
      return next
    })

  const relative = (event: { clientX: number; clientY: number }): Point => {
    const box = list.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  const startDrag = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || target.closest('button, input, a') || !list.current) return
    if (event.shiftKey) event.preventDefault()
    const start = relative(event)
    const before = current.current
    const additive = toggleKey(event)
    const pressed = target.closest<HTMLElement>('[data-index]')
    const startIndex = pressed ? Number(pressed.dataset.index) : null
    let dragging = false
    dragged.current = false
    const move = (moved: globalThis.MouseEvent) => {
      const point = relative(moved)
      if (!dragging && !isDrag(start, point)) return
      dragging = true
      dragged.current = true
      const boxes = Array.from(list.current!.querySelectorAll<HTMLElement>('[data-index]')).map((element) => {
        const box = element.getBoundingClientRect()
        const origin = list.current!.getBoundingClientRect()
        return { top: box.top - origin.top, bottom: box.bottom - origin.top }
      })
      onSelect(dragSelection(before, order, rowsInBand(boxes, start, point), additive, startIndex))
      setRectangle(band(start, point))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setRectangle(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const focusRow = (index: number) =>
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${Math.max(0, Math.min(order.length - 1, index))}"]`)
      ?.focus()

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

  const rowKeys = (event: KeyboardEvent<HTMLDivElement>, row: SearchRow, index: number) => {
    if (openRowContext(event)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(order.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
      if (event.shiftKey)
        onSelect(
          clickSelection(selection.anchor === null ? { ...selection, anchor: index } : selection, order, next, {
            shift: true,
          }),
        )
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
      {rows.map((row, index) => {
        const selected = selection.ids.has(row.nodeId)
        const expanded = open.has(row.nodeId)
        const staged = props.stagedIds.has(row.nodeId)
        const split = row.path.length - row.name.length
        return (
          <div key={row.nodeId} role="none">
            <div
              className={`tree-row match-row${selected ? ' selected' : ''}`}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={row.kind === 'dir' ? expanded : undefined}
              data-index={index}
              tabIndex={0}
              title={row.path}
              onClick={(event) => {
                if (dragged.current) {
                  dragged.current = false
                  return
                }
                onSelect(clickSelection(selection, order, index, { shift: event.shiftKey, toggle: toggleKey(event) }))
              }}
              onDoubleClick={() => row.kind === 'dir' && toggleOpen(row.nodeId)}
              onContextMenu={(event) => props.onContextMenu(row, event, row.depth)}
              onKeyDown={(event) => rowKeys(event, row, index)}
            >
              <span className="tree-name" style={{ paddingLeft: '14px' }}>
                {row.kind === 'dir' ? (
                  <button
                    className="chevron chevron-button"
                    tabIndex={-1}
                    aria-label={expanded ? 'Hide contents' : 'Show contents'}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleOpen(row.nodeId)
                    }}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="chevron" aria-hidden />
                )}
                <span className={`name kind-${row.kind}${staged ? ' staged-row' : ''}`}>
                  <NodeIcon kind={row.kind === 'dir' ? 'dir' : 'file'} />
                  <span className="node-name">
                    <span className="match-parent">{row.path.slice(0, split)}</span>
                    {row.name}
                  </span>
                  {staged && <span className="tag staged">queued</span>}
                </span>
              </span>
              <NodeCells
                row={row}
                share={props.visibleSize > 0 ? row.size / props.visibleSize : 0}
                shareLabel="of visible space"
              />
            </div>
            {expanded && (
              <LazyChildren<TreeRow>
                reloadKey={props.reloadKey}
                rootId={row.nodeId}
                depth={1}
                load={props.load}
                rowId={(child) => child.nodeId}
                canExpand={(child) => child.kind === 'dir'}
                emptyText="Empty folder"
                renderRow={props.renderChild}
                onContextMenu={(child, event, depth) => props.onContextMenu(child, event, row.depth + depth)}
              />
            )}
          </div>
        )
      })}
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
