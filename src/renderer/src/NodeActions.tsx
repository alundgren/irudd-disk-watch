import type { NodeKind } from '../../shared/types'
import { api } from './api'

interface NodeActionsProps {
  nodeId: number
  path?: string
  kind: Exclude<NodeKind, 'rest'>
  size: number
  files: number
  canDelete: boolean
  staged: boolean
  onExclude(path: string): void
  onToggleDelete(item: {
    nodeId: number
    path?: string
    kind: Exclude<NodeKind, 'rest'>
    size: number
    files: number
  }): void
}

export function NodeActions({
  nodeId,
  path,
  kind,
  size,
  files,
  canDelete,
  staged,
  onExclude,
  onToggleDelete,
}: NodeActionsProps) {
  const withPath = (action: (resolvedPath: string) => void) => async (e: React.MouseEvent) => {
    e.stopPropagation()
    action(path ?? (await api.nodePath(nodeId)))
  }
  return (
    <span className="row-actions">
      <button title="Show in Explorer" onClick={withPath((resolvedPath) => api.showInExplorer(resolvedPath))}>
        Show
      </button>
      <button
        title={`Exclude this ${kind === 'file' ? 'file' : 'folder'} from views and future scans`}
        onClick={withPath(onExclude)}
      >
        Exclude
      </button>
      {canDelete && (
        <button
          className={staged ? 'danger' : 'danger-quiet'}
          title={staged ? 'Remove from delete queue' : 'Queue for deletion'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleDelete({ nodeId, path, kind, size, files })
          }}
        >
          {staged ? 'Unqueue' : 'Queue delete'}
        </button>
      )}
    </span>
  )
}
