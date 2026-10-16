import { containsPath, pathKey } from '../../shared/paths'
import type { StagedDelete } from '../../shared/types'

export function sameTarget(a: StagedDelete, b: StagedDelete) {
  return a.components && b.components
    ? a.machineId === b.machineId && JSON.stringify(a.components) === JSON.stringify(b.components)
    : !a.components && !b.components && pathKey(a.path) === pathKey(b.path)
}
export function containsTarget(parent: StagedDelete, child: StagedDelete) {
  return parent.components && child.components
    ? parent.machineId === child.machineId &&
        parent.components.length <= child.components.length &&
        parent.components.every((component, index) => component === child.components![index])
    : !parent.components && !child.components && containsPath(parent.path, child.path)
}
export function summarizeStaged(items: StagedDelete[]) {
  const top = items.filter((item) => !items.some((other) => !sameTarget(other, item) && containsTarget(other, item)))
  return {
    items,
    top,
    size: top.reduce((sum, item) => sum + item.size, 0),
    files: top.reduce((sum, item) => sum + item.files, 0),
  }
}
