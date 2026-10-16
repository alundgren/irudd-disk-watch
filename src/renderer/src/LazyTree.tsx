import { useEffect, useState, type ReactNode, type MouseEvent } from 'react'
import type { NodeKind } from '../../shared/types'
import { openRowContext } from './rowContext'
import { errorText } from './bulkQueue'

const PAGE = 200

interface LazyTreeProps<Row extends { kind: NodeKind }> {
  /** Changing this key drops every loaded branch. */
  reloadKey: string
  rootId: number
  load(nodeId: number): Promise<Row[]>
  rowId(row: Row): number
  canExpand(row: Row): boolean
  renderRow(row: Row, siblings: Row[], depth: number): { name: ReactNode; cells: ReactNode }
  emptyText: string
  rootRows?: Row[]
  onContextMenu?(row: Row, event: MouseEvent, depth: number): void
}

export function LazyTree<Row extends { kind: NodeKind }>(props: LazyTreeProps<Row>) {
  return (
    <div className="tree" role="tree">
      <Branch key={props.reloadKey} {...props} nodeId={props.rootId} depth={0} />
    </div>
  )
}

/** Children of one node inside another tree, such as an expanded Space filter match. */
export function LazyChildren<Row extends { kind: NodeKind }>(props: LazyTreeProps<Row> & { depth: number }) {
  return <Branch key={props.reloadKey} {...props} nodeId={props.rootId} />
}

function Branch<Row extends { kind: NodeKind }>(props: LazyTreeProps<Row> & { nodeId: number; depth: number }) {
  const { load, nodeId } = props
  const prepared = props.depth === 0 ? props.rootRows : undefined
  const [rows, setRows] = useState<Row[] | null>(prepared ?? null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (prepared) {
      setRows(prepared)
      return
    }
    setError(null)
    let live = true
    load(nodeId).then(
      (loaded) => live && setRows(loaded),
      (err: unknown) => live && setError(errorText(err)),
    )
    return () => {
      live = false
    }
  }, [load, nodeId, prepared, attempt])

  const indent = { paddingLeft: `${props.depth * 18 + 8}px` }
  if (error)
    return (
      <div className="tree-note" style={indent}>
        Could not load: {error}
        <button onClick={() => setAttempt(attempt + 1)}>Retry</button>
      </div>
    )
  if (!rows)
    return (
      <div className="tree-note" style={indent}>
        Loading…
      </div>
    )
  if (rows.length === 0)
    return (
      <div className="tree-note" style={indent}>
        {props.emptyText}
      </div>
    )
  const visibleRows = rows.filter((row) => row.kind !== 'rest')
  return (
    <div role="group">
      {visibleRows.slice(0, limit).map((row) => (
        <Node key={props.rowId(row)} {...props} row={row} siblings={rows} />
      ))}
      {visibleRows.length > limit && (
        <button className="tree-more" style={indent} onClick={() => setLimit(visibleRows.length)}>
          Show {(visibleRows.length - limit).toLocaleString('en-US')} more
        </button>
      )}
    </div>
  )
}

function Node<Row extends { kind: NodeKind }>(
  props: LazyTreeProps<Row> & { row: Row; siblings: Row[]; depth: number },
) {
  const [open, setOpen] = useState(false)
  const { row, depth } = props
  const expandable = props.canExpand(row)
  const { name, cells } = props.renderRow(row, props.siblings, depth)
  return (
    <>
      <div
        className={`tree-row${expandable ? ' expandable' : ''}${depth > 0 ? ' child-row' : ''}`}
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        tabIndex={0}
        onClick={() => expandable && setOpen(!open)}
        onContextMenu={(event) => props.onContextMenu?.(row, event, depth)}
        onKeyDown={(e) => {
          if (openRowContext(e)) return
          if (!expandable) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          }
          if (e.key === 'ArrowRight') setOpen(true)
          if (e.key === 'ArrowLeft') setOpen(false)
        }}
      >
        <span className="tree-name" style={{ paddingLeft: `${depth * 22 + 14}px` }}>
          <span className="chevron" aria-hidden>
            {expandable ? (open ? '▾' : '▸') : ''}
          </span>
          {name}
        </span>
        {cells}
      </div>
      {open && <Branch {...props} nodeId={props.rowId(row)} depth={depth + 1} />}
    </>
  )
}
