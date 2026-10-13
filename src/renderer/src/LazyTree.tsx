import { useEffect, useState, type ReactNode } from 'react'

const PAGE = 200

interface LazyTreeProps<Row> {
  /** Changing this key drops every loaded branch. */
  reloadKey: string
  rootId: number
  load(nodeId: number): Promise<Row[]>
  rowId(row: Row): number
  canExpand(row: Row): boolean
  renderRow(row: Row, siblings: Row[]): { name: ReactNode; cells: ReactNode }
  emptyText: string
}

export function LazyTree<Row>(props: LazyTreeProps<Row>) {
  return (
    <div className="tree" role="tree">
      <Branch key={props.reloadKey} {...props} nodeId={props.rootId} depth={0} />
    </div>
  )
}

function Branch<Row>(props: LazyTreeProps<Row> & { nodeId: number; depth: number }) {
  const { load, nodeId } = props
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => {
    let live = true
    load(nodeId).then(
      (loaded) => live && setRows(loaded),
      (err: Error) => live && setError(err.message),
    )
    return () => {
      live = false
    }
  }, [load, nodeId])

  const indent = { paddingLeft: `${props.depth * 18 + 8}px` }
  if (error)
    return (
      <div className="tree-note" style={indent}>
        Could not load: {error}
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
  return (
    <div role="group">
      {rows.slice(0, limit).map((row) => (
        <Node key={props.rowId(row)} {...props} row={row} siblings={rows} />
      ))}
      {rows.length > limit && (
        <button className="tree-more" style={indent} onClick={() => setLimit(rows.length)}>
          Show {(rows.length - limit).toLocaleString('en-US')} more
        </button>
      )}
    </div>
  )
}

function Node<Row>(props: LazyTreeProps<Row> & { row: Row; siblings: Row[]; depth: number }) {
  const [open, setOpen] = useState(false)
  const { row, depth } = props
  const expandable = props.canExpand(row)
  const { name, cells } = props.renderRow(row, props.siblings)
  return (
    <>
      <div
        className={`tree-row${expandable ? ' expandable' : ''}`}
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        tabIndex={expandable ? 0 : -1}
        onClick={() => expandable && setOpen(!open)}
        onKeyDown={(e) => {
          if (!expandable) return
          if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
          if (e.key === 'ArrowRight') setOpen(true)
          if (e.key === 'ArrowLeft') setOpen(false)
        }}
      >
        <span className="tree-name" style={{ paddingLeft: `${depth * 18}px` }}>
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
