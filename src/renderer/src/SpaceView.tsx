import { useCallback, useState, type MouseEvent } from 'react'
import type { Disk, NodeKind, ScanSummary, StagedDelete, TreeRow, ViewTotal } from '../../shared/types'
import { api, formatBytes, formatCount, isWindows } from './api'
import { LazyTree } from './LazyTree'
import { NodeAge } from './NodeAge'
import { NodeIcon } from './NodeIcon'
import { ScanPicker } from './ScanPicker'
import { ScanDiagnostics } from './ScanDiagnostics'

interface SpaceViewProps {
  disk: Disk
  scans: ScanSummary[]
  staged: StagedDelete[]
  scanId: number
  rows: TreeRow[]
  total: ViewTotal
  onChooseDrive(): void
  onPick(scanId: number): void
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

export function SpaceView({
  disk,
  scans,
  scanId,
  rows,
  total,
  onPick,
  onContext,
  staged,
  onChooseDrive,
}: SpaceViewProps) {
  const scan = scans.find((s) => s.id === scanId)!
  const revision = disk.hides.revision
  const stagedIds = new Set(staged.map((item) => item.nodeId))
  const [sort, setSort] = useState<'size' | 'written'>('size')
  const order = useCallback(
    (items: TreeRow[]) =>
      [...items].sort((a, b) =>
        sort === 'written' ? (b.lastWrittenAt ?? 0) - (a.lastWrittenAt ?? 0) || b.size - a.size : b.size - a.size,
      ),
    [sort],
  )
  const load = useCallback(
    async (nodeId: number) => order(await api.children(scan.id, nodeId, revision)),
    [scan.id, revision, order],
  )

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="Scan" scans={scans} value={scan.id} onChange={onPick} />
        <span className="strong">{formatBytes(total.visible.size)} visible</span>
        <span className="muted">
          {formatBytes(total.raw.size)} captured · {formatBytes(total.hidden.size)} hidden ·{' '}
          {formatCount(total.visible.files)} visible files
          {scan.errors > 0 && ` · ${formatCount(scan.errors)} items could not be read`}
        </span>
      </div>
      <ScanDiagnostics key={scan.id} scan={scan} unix={!isWindows(disk)} onChooseDrive={onChooseDrive} />
      <div className="columns space-columns">
        <span>Name</span>
        <button className="column-sort num" onClick={() => setSort('size')} aria-pressed={sort === 'size'}>
          Size{sort === 'size' ? ' ↓' : ''}
        </button>
        <span className="num">Files</span>
        <button
          className="column-sort age-heading"
          onClick={() => setSort('written')}
          aria-pressed={sort === 'written'}
        >
          Age{sort === 'written' ? ' ↓' : ''}
        </button>
      </div>
      <LazyTree<TreeRow>
        reloadKey={`${scan.id}-${revision}-${sort}`}
        rootId={disk.rootNode}
        rootRows={order(rows)}
        onContextMenu={(row, event, depth) => {
          if (row.kind !== 'rest')
            onContext(
              {
                nodeId: row.nodeId,
                kind: row.kind,
                size: row.size,
                files: row.files,
                canDelete: depth >= 1,
              },
              event,
            )
        }}
        load={load}
        rowId={(row) => row.nodeId}
        canExpand={(row) => row.kind === 'dir'}
        emptyText={
          scan.coverage === 'partial'
            ? 'No captured entries in this partial scan'
            : scan.files === 0 && (scan.skipped?.mounts ?? 0) > 0
              ? 'No files captured within this mount scope'
              : 'Empty folder'
        }
        renderRow={(row, siblings) => {
          const parentSize = siblings.reduce((sum, s) => sum + s.size, 0)
          const share = parentSize > 0 ? row.size / parentSize : 0
          const isStaged = stagedIds.has(row.nodeId)
          const [size, unit] = formatBytes(row.size).split(' ')
          return {
            name: (
              <span className={`name kind-${row.kind}${isStaged ? ' staged-row' : ''}`}>
                {row.kind !== 'rest' && <NodeIcon kind={row.kind} />}
                <span className="node-name">{row.name}</span>
                {isStaged && <span className="tag staged">queued</span>}
              </span>
            ),
            cells: (
              <>
                <span className="size-cell">
                  <span className="size-value">
                    {size}
                    <span className="size-unit"> {unit}</span>
                  </span>
                  <span className="bar" title={`${Math.round(share * 100)}% of the folder above`}>
                    <span style={{ width: `${share * 100}%` }} />
                  </span>
                </span>
                <span className="num file-count muted">{formatCount(row.files)}</span>
                <NodeAge createdAt={row.createdAt} lastWrittenAt={row.lastWrittenAt} folder={row.kind === 'dir'} />
              </>
            ),
          }
        }}
      />
    </div>
  )
}
