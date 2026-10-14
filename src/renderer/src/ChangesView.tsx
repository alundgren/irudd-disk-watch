import { useCallback, useState, type MouseEvent } from 'react'
import { canDeletePath } from '../../shared/paths'
import type { Comparison, DiffRow, Disk, Hotspot, NodeKind, ScanSummary, StagedDelete } from '../../shared/types'
import { api, formatBytes, formatDelta } from './api'
import { LazyTree } from './LazyTree'
import { NodeIcon } from './NodeIcon'
import { openRowContext } from './rowContext'
import { ScanPicker } from './ScanPicker'

interface ChangesViewProps {
  disk: Disk
  scans: ScanSummary[]
  staged: StagedDelete[]
  comparison: Comparison
  onPick(field: 'from' | 'to', scanId: number): void
  onContext(
    target: {
      nodeId: number
      path?: string
      kind?: Exclude<NodeKind, 'rest'>
      size?: number
      files?: number
      canDelete?: boolean
    },
    event: MouseEvent,
  ): void
}

const delta = (row: DiffRow) => (row.after?.size ?? 0) - (row.before?.size ?? 0)

export function ChangesView({ disk, scans, comparison, onPick, onContext, staged }: ChangesViewProps) {
  const [hideUnchanged, setHideUnchanged] = useState(true)
  const { fromId, toId, revision } = comparison
  const stagedIds = new Set(staged.map((item) => item.nodeId))
  const load = useCallback(
    async (nodeId: number) => {
      const rows = await api.diffChildren(fromId, toId, nodeId, revision)
      return hideUnchanged ? rows.filter((row) => delta(row) !== 0 || row.before === null || row.after === null) : rows
    },
    [fromId, toId, revision, hideUnchanged],
  )
  const from = scans.find((scan) => scan.id === fromId)!
  const to = scans.find((scan) => scan.id === toId)!
  const pickFrom = (id: number) => onPick('from', id)
  const pickTo = (id: number) => onPick('to', id)
  if (fromId === toId) {
    return (
      <div className="view">
        <div className="view-bar">
          <ScanPicker label="From" scans={scans} value={fromId} onChange={pickFrom} />
          <ScanPicker label="To" scans={scans} value={toId} onChange={pickTo} />
        </div>
        <p className="empty">Pick two different scans to compare.</p>
      </div>
    )
  }

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="From" scans={scans} value={fromId} onChange={pickFrom} />
        <ScanPicker label="To" scans={scans} value={toId} onChange={pickTo} />
        <span
          className={`total ${comparison.after.visible.size >= comparison.before.visible.size ? 'grew' : 'shrank'}`}
        >
          {formatDelta(comparison.after.visible.size - comparison.before.visible.size)}
        </span>
      </div>

      <p className="muted small accounting">
        Captured {formatBytes(comparison.before.raw.size)} → {formatBytes(comparison.after.raw.size)} · Hidden{' '}
        {formatBytes(comparison.before.hidden.size)} → {formatBytes(comparison.after.hidden.size)}
      </p>
      <div className="hotspots">
        <SummarizeHotspotList
          root={disk.root}
          title="Where new data landed"
          hint="Folders whose own files grew the most"
          items={comparison.grownFolders}
          stagedIds={stagedIds}
          onContext={onContext}
        />
        <SummarizeHotspotList
          root={disk.root}
          title="New folders"
          hint="The biggest folders that did not exist before"
          items={comparison.newFolders}
          stagedIds={stagedIds}
          onContext={onContext}
        />
      </div>

      <div className="columns diff-columns">
        <span>Name</span>
        <span className="num">Before</span>
        <span className="num">After</span>
        <span className="num">Change</span>
      </div>
      <label className="toggle changes-toggle">
        <input type="checkbox" checked={hideUnchanged} onChange={(e) => setHideUnchanged(e.target.checked)} />
        Hide unchanged
      </label>
      <LazyTree<DiffRow>
        reloadKey={`${from.id}-${to.id}-${revision}-${hideUnchanged}`}
        rootRows={
          hideUnchanged
            ? comparison.rows.filter((row) => delta(row) !== 0 || row.before === null || row.after === null)
            : comparison.rows
        }
        onContextMenu={(row, event, depth) => {
          if (row.kind !== 'rest')
            onContext(
              {
                nodeId: row.nodeId,
                kind: row.kind,
                size: row.after?.size ?? row.before?.size ?? 0,
                files: row.after?.files ?? row.before?.files ?? 0,
                canDelete: depth >= 1 && row.after !== null,
              },
              event,
            )
        }}
        rootId={disk.rootNode}
        load={load}
        rowId={(row) => row.nodeId}
        canExpand={(row) => row.kind === 'dir'}
        emptyText={hideUnchanged ? 'Nothing changed here' : 'Empty folder'}
        renderRow={(row) => {
          const change = delta(row)
          const status = row.before === null ? 'new' : row.after === null ? 'gone' : null
          const isStaged = stagedIds.has(row.nodeId)
          const name = row.name
          return {
            name: (
              <span
                className={`name kind-${row.kind}${status === 'gone' ? ' gone' : ''}${isStaged ? ' staged-row' : ''}`}
              >
                {row.kind !== 'rest' && <NodeIcon kind={row.kind} />}
                <span className="node-name">{name}</span>
                {status && <span className={`tag ${status}`}>{status}</span>}
                {isStaged && <span className="tag staged">queued</span>}
              </span>
            ),
            cells: (
              <>
                <span className="num muted">{row.before ? formatBytes(row.before.size) : ''}</span>
                <span className="num muted">{row.after ? formatBytes(row.after.size) : ''}</span>
                <span className={`num strong ${change > 0 ? 'grew' : change < 0 ? 'shrank' : 'muted'}`}>
                  {change === 0 ? 'same' : formatDelta(change)}
                </span>
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
  items: Hotspot[]
  stagedIds: Set<number>
  onContext(
    target: {
      nodeId: number
      path?: string
      kind?: Exclude<NodeKind, 'rest'>
      size?: number
      files?: number
      canDelete?: boolean
    },
    event: MouseEvent,
  ): void
}

function SummarizeHotspotList({ root, title, hint, items, stagedIds, onContext }: HotspotListProps) {
  const prefix = root.endsWith('\\') ? root : `${root}\\`
  return (
    <section>
      <h3>{title}</h3>
      <p className="muted small">{hint}</p>
      {items.length === 0 ? (
        <p className="muted small">None</p>
      ) : (
        <ol>
          {items.map((item) => {
            const isRoot = item.path.toLowerCase() === root.toLowerCase()
            const deletable = !isRoot && canDeletePath(root, item.path)
            const isStaged = stagedIds.has(item.nodeId)
            return (
              <li
                key={item.nodeId}
                tabIndex={0}
                onKeyDown={openRowContext}
                onContextMenu={(event) => {
                  onContext(
                    {
                      nodeId: item.nodeId,
                      path: item.path,
                      kind: isRoot ? undefined : 'dir',
                      size: item.after,
                      files: 0,
                      canDelete: deletable,
                    },
                    event,
                  )
                }}
              >
                <span className="hotspot-path">
                  <span className={`path${isStaged ? ' staged-row' : ''}`} title={item.path}>
                    {item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path}
                  </span>
                  {isStaged && <span className="tag staged">queued</span>}
                </span>
                <span className="num grew strong">{formatDelta(item.after - item.before)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
