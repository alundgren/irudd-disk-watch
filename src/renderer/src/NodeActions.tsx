import { api } from './api'

interface NodeActionsProps {
  nodeId: number
  canExclude: boolean
  onExclude(path: string): void
}

export function NodeActions({ nodeId, canExclude, onExclude }: NodeActionsProps) {
  const withPath = (action: (path: string) => void) => async (e: React.MouseEvent) => {
    e.stopPropagation()
    action(await api.nodePath(nodeId))
  }
  return (
    <span className="row-actions">
      <button title="Show in Explorer" onClick={withPath((path) => api.showInExplorer(path))}>
        Show
      </button>
      {canExclude && (
        <button title="Leave this folder out of future scans" onClick={withPath(onExclude)}>
          Exclude
        </button>
      )}
    </span>
  )
}
