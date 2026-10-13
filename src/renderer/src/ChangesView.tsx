import { useCallback, useEffect, useState } from 'react'
import type { DiffRow, Disk, Hotspot, ScanChanges, ScanSummary } from '../../shared/types'
import { api, formatBytes, formatCount, formatDelta } from './api'
import { LazyTree } from './LazyTree'
import { NodeActions } from './NodeActions'
import { ScanPicker } from './ScanPicker'

interface ChangesViewProps {
  disk: Disk
  scans: ScanSummary[]
  onExclude(path: string): void
}

const delta = (row: DiffRow) => (row.after?.size ?? 0) - (row.before?.size ?? 0)

export function ChangesView({ disk, scans, onExclude }: ChangesViewProps) {
  const [toId, setToId] = useState(scans[0]!.id)
  const [fromId, setFromId] = useState(scans[1]!.id)
  const [hideUnchanged, setHideUnchanged] = useState(true)
  const [changes, setChanges] = useState<ScanChanges | null>(null)
  const pick = (id: number) => scans.find((scan) => scan.id === id) ?? scans[0]!
  const [from, to] = [pick(fromId), pick(toId)].sort((a, b) => a.startedAt - b.startedAt) as [ScanSummary, ScanSummary]

  useEffect(() => {
    let live = true
    setChanges(null)
    api.changes(from.id, to.id).then((loaded) => live && setChanges(loaded))
    return () => {
      live = false
    }
  }, [from, to])

  const load = useCallback(
    async (nodeId: number) => {
      const rows = await api.diffChildren(from.id, to.id, nodeId)
      return hideUnchanged ? rows.filter((row) => delta(row) !== 0) : rows
    },
    [from, to, hideUnchanged],
  )

  if (from.id === to.id) {
    return (
      <div className="view">
        <div className="view-bar">
          <ScanPicker label="From" scans={scans} value={fromId} onChange={setFromId} />
          <ScanPicker label="To" scans={scans} value={toId} onChange={setToId} />
        </div>
        <p className="empty">Pick two different scans to compare.</p>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="From" scans={scans} value={fromId} onChange={setFromId} />
        <ScanPicker label="To" scans={scans} value={toId} onChange={setToId} />
        <span className={`total ${to.size >= from.size ? 'grew' : 'shrank'}`}>{formatDelta(to.size - from.size)}</span>
      </div>

      <div className="hotspots">
        <HotspotList
          root={disk.root}
          title="Where new data landed"
          hint="Folders whose own files grew the most"
          items={changes?.grownFolders}
        />
        <HotspotList
          root={disk.root}
          title="New folders"
          hint="The biggest folders that did not exist before"
          items={changes?.newFolders}
        />
      </div>

      <div className="columns diff-columns">
        <span>Name</span>
        <span className="num">Before</span>
        <span className="num">After</span>
        <span className="num">Change</span>
        <label className="toggle">
          <input type="checkbox" checked={hideUnchanged} onChange={(e) => setHideUnchanged(e.target.checked)} />
          Hide unchanged
        </label>
      </div>
      <LazyTree<DiffRow>
        reloadKey={`${from.id}-${to.id}-${hideUnchanged}`}
        rootId={disk.rootNode}
        load={load}
        rowId={(row) => row.nodeId}
        canExpand={(row) => row.kind === 'dir'}
        emptyText={hideUnchanged ? 'Nothing changed here' : 'Empty folder'}
        renderRow={(row) => {
          const change = delta(row)
          const status = row.before === null ? 'new' : row.after === null ? 'gone' : null
          const name =
            row.kind === 'rest' ? `${formatCount(row.after?.files ?? row.before?.files ?? 0)} smaller files` : row.name
          return {
            name: (
              <span className={`name kind-${row.kind}${status === 'gone' ? ' gone' : ''}`}>
                {name}
                {status && <span className={`tag ${status}`}>{status}</span>}
              </span>
            ),
            cells: (
              <>
                <span className="num muted">{row.before ? formatBytes(row.before.size) : ''}</span>
                <span className="num muted">{row.after ? formatBytes(row.after.size) : ''}</span>
                <span className={`num strong ${change > 0 ? 'grew' : change < 0 ? 'shrank' : 'muted'}`}>
                  {change === 0 ? 'same' : formatDelta(change)}
                </span>
                {row.kind === 'rest' || status === 'gone' ? (
                  <span />
                ) : (
                  <NodeActions nodeId={row.nodeId} canExclude={row.kind === 'dir'} onExclude={onExclude} />
                )}
              </>
            ),
          }
        }}
      />
    </div>
  )
}

interface HotspotListProps {
  root: string
  title: string
  hint: string
  items: Hotspot[] | undefined
}

function HotspotList({ root, title, hint, items }: HotspotListProps) {
  const prefix = root.endsWith('\\') ? root : `${root}\\`
  return (
    <section>
      <h3>{title}</h3>
      <p className="muted small">{hint}</p>
      {!items ? (
        <p className="muted small">Comparing…</p>
      ) : items.length === 0 ? (
        <p className="muted small">None</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.nodeId}>
              <button
                className="path"
                title={`Show ${item.path} in Explorer`}
                onClick={() => api.showInExplorer(item.path)}
              >
                {item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path}
              </button>
              <span className="num grew strong">{formatDelta(item.after - item.before)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
