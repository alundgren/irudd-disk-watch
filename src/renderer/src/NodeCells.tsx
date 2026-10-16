import type { TreeRow } from '../../shared/types'
import { formatBytes, formatCount } from './api'
import { NodeAge } from './NodeAge'

/** Size, Files and Age cells of a Space row. `share` fills the size bar, from 0 to 1. */
export function NodeCells({ row, share, shareLabel }: { row: TreeRow; share: number; shareLabel: string }) {
  const [size, unit] = formatBytes(row.size).split(' ')
  return (
    <>
      <span className="size-cell">
        <span className="size-value">
          {size}
          <span className="size-unit"> {unit}</span>
        </span>
        <span className="bar" title={`${Math.round(share * 100)}% ${shareLabel}`}>
          <span style={{ width: `${share * 100}%` }} />
        </span>
      </span>
      <span className="num file-count muted">{formatCount(row.files)}</span>
      <NodeAge createdAt={row.createdAt} lastWrittenAt={row.lastWrittenAt} folder={row.kind === 'dir'} />
    </>
  )
}
