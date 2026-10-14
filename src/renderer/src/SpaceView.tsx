import { useCallback, type MouseEvent } from 'react'
import type { Disk, NodeKind, ScanSummary, StagedDelete, TreeRow, ViewTotal } from '../../shared/types'
import { api, formatBytes, formatCount } from './api'
import { LazyTree } from './LazyTree'
import { NodeActions } from './NodeActions'
import { ScanPicker } from './ScanPicker'

interface SpaceViewProps {
  disk: Disk
  scans: ScanSummary[]
  onExclude(path: string): void
  staged: StagedDelete[]
  onToggleDelete(item: { nodeId: number; kind: Exclude<NodeKind, 'rest'>; size: number; files: number }): void
  scanId: number
  rows: TreeRow[]
  total: ViewTotal
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
  onExclude,
  staged,
  onToggleDelete,
}: SpaceViewProps) {
  const scan = scans.find((s) => s.id === scanId)!
  const revision = disk.hides.revision
  const stagedIds = new Set(staged.map((item) => item.nodeId))
  const load = useCallback((nodeId: number) => api.children(scan.id, nodeId, revision), [scan.id, revision])

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="Scan" scans={scans} value={scan.id} onChange={onPick} />
        <span className="strong">{formatBytes(total.visible.size)} visible</span>
        <span className="muted">
          {formatBytes(total.raw.size)} captured · {formatBytes(total.hidden.size)} hidden ·{' '}
          {formatCount(total.visible.files)} visible files
          {scan.errors > 0 && ` · ${formatCount(scan.errors)} folders could not be read`}
        </span>
      </div>
      <div className="columns space-columns">
        <span>Name</span>
        <span />
        <span className="num">Size</span>
        <span className="num">Files</span>
        <span />
      </div>
      <LazyTree<TreeRow>
        reloadKey={`${scan.id}-${revision}`}
        rootId={disk.rootNode}
        rootRows={rows}
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
        emptyText="Empty folder"
        renderRow={(row, siblings, depth) => {
          const parentSize = siblings.reduce((sum, s) => sum + s.size, 0)
          const share = parentSize > 0 ? row.size / parentSize : 0
          const isStaged = stagedIds.has(row.nodeId)
          return {
            name: (
              <span className={`name kind-${row.kind}${isStaged ? ' staged-row' : ''}`}>
                {row.name}
                {isStaged && <span className="tag staged">queued</span>}
              </span>
            ),
            cells: (
              <>
                <span className="bar" title={`${Math.round(share * 100)}% of the folder above`}>
                  <span style={{ width: `${share * 100}%` }} />
                </span>
                <span className="num strong">{formatBytes(row.size)}</span>
                <span className="num muted">{formatCount(row.files)}</span>
                {row.kind === 'rest' ? (
                  <span />
                ) : (
                  <NodeActions
                    nodeId={row.nodeId}
                    kind={row.kind}
                    size={row.size}
                    files={row.files}
                    canDelete={depth >= 1}
                    staged={isStaged}
                    onExclude={onExclude}
                    onToggleDelete={onToggleDelete}
                  />
                )}
              </>
            ),
          }
        }}
      />
    </div>
  )
}
