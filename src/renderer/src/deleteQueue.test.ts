import { describe, expect, it } from 'vite-plus/test'
import type { StagedDelete } from '../../shared/types'
import { containsTarget, sameTarget, summarizeStaged } from './deleteQueue'

const target = (path: string, components?: string[], machineId = 'test-machine'): StagedDelete => ({
  nodeId: 1,
  scanId: 1,
  kind: 'dir',
  size: 10,
  files: 1,
  path,
  components,
  machineId,
})

describe('deletion queue identity', () => {
  it('counts native descendants once without interpreting escaped labels', () => {
    const parent = target('/root/\\xff', ['/w=='])
    const child = target('/root/a label that does not match', ['/w==', 'YQ=='])
    const unrelated = target('/root/\\xff/a', ['YWJj'])
    const summary = summarizeStaged([parent, child, unrelated])
    expect(summary.top).toEqual([parent, unrelated])
    expect(summary.size).toBe(20)
    expect(containsTarget(parent, child)).toBe(true)
    expect(containsTarget(parent, unrelated)).toBe(false)
  })

  it('keeps different byte names and machines separate even when labels coincide', () => {
    const a = target('/same/display', ['YQ=='])
    const upper = target('/same/display', ['QQ=='])
    const differentMachine = target('/same/display', ['YQ=='], 'other-machine')
    expect(sameTarget(a, upper)).toBe(false)
    expect(containsTarget(a, upper)).toBe(false)
    expect(sameTarget(a, differentMachine)).toBe(false)
    expect(containsTarget(a, differentMachine)).toBe(false)
    expect(summarizeStaged([a, upper, differentMachine]).top).toHaveLength(3)
  })

  it('retains Windows case-insensitive containment without matching sibling prefixes', () => {
    const parent = target('C:\\Downloads\\cache')
    const child = target('c:\\downloads\\CACHE\\item.bin')
    const sibling = target('C:\\Downloads\\cache-other')
    expect(containsTarget(parent, child)).toBe(true)
    expect(containsTarget(parent, sibling)).toBe(false)
    expect(sameTarget(parent, target('c:\\DOWNLOADS\\cache'))).toBe(true)
    expect(summarizeStaged([child, parent, sibling]).top).toEqual([parent, sibling])
  })
})
