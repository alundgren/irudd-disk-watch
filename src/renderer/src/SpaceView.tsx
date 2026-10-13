import { useCallback, useState } from 'react'
import type { Disk, ScanSummary, TreeRow } from '../../shared/types'
import { api, formatBytes, formatCount } from './api'
import { LazyTree } from './LazyTree'
import { NodeActions } from './NodeActions'
import { ScanPicker } from './ScanPicker'

interface SpaceViewProps {
  disk: Disk
  scans: ScanSummary[]
  onExclude(path: string): void
}

export function SpaceView({ disk, scans, onExclude }: SpaceViewProps) {
  const [chosen, setChosen] = useState<number | null>(null)
  const scan = scans.find((s) => s.id === chosen) ?? scans[0]!
  const load = useCallback((nodeId: number) => api.children(scan.id, nodeId), [scan.id])

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="Scan" scans={scans} value={scan.id} onChange={setChosen} />
        <span className="muted">
          {formatCount(scan.files)} files in {formatCount(scan.dirs)} folders
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
        reloadKey={String(scan.id)}
        rootId={disk.rootNode}
        load={load}
        rowId={(row) => row.nodeId}
        canExpand={(row) => row.kind === 'dir'}
        emptyText="Empty folder"
        renderRow={(row, siblings) => {
          const parentSize = siblings.reduce((sum, s) => sum + s.size, 0)
          const share = parentSize > 0 ? row.size / parentSize : 0
          return {
            name: (
              <span className={`name kind-${row.kind}`}>
                {row.kind === 'rest' ? `${formatCount(row.files)} smaller files` : row.name}
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
