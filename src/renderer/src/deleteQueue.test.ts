import { describe, expect, it } from 'vite-plus/test'
import type { ScanSummary, StagedDelete } from '../../shared/types'
import { containsTarget, QueueIndex, sameTarget, summarizeStaged, verifiedScanTime } from './deleteQueue'

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

describe('partial scans and deletion follow-up', () => {
  const scan = (id: number, startedAt: number, status: ScanSummary['status'], coverage: ScanSummary['coverage']) =>
    ({ id, diskId: 1, startedAt, status, coverage }) as ScanSummary

  it('lets a newer partial scan end the wait after a deletion, but not a failed one', () => {
    const scans = [
      scan(3, 300, 'failed', 'complete'),
      scan(2, 200, 'complete', 'partial'),
      scan(1, 100, 'complete', 'complete'),
    ]
    expect(verifiedScanTime(scans)).toBe(200)
    expect(verifiedScanTime([])).toBe(0)
    // A newer scan ID wins even if its recorded start time is earlier.
    expect(verifiedScanTime([scan(5, 150, 'complete', 'partial'), scan(4, 400, 'complete', 'complete')])).toBe(150)
  })

  it('marks the summary when any top-level item came from a partial scan', () => {
    const partial = { ...target('/root/a', ['YQ==']), partialScan: true }
    expect(summarizeStaged([target('/root/b', ['Yg=='])]).partial).toBe(false)
    expect(summarizeStaged([partial, target('/root/b', ['Yg=='])]).partial).toBe(true)
  })
})

describe('bulk queue index', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64')
  const native = (...parts: string[]) => target(`/root/${parts.join('/')}`, parts.map(b64))

  it('finds holders, merges contained items and refuses additions past the limit', () => {
    const index = new QueueIndex([native('a', 'b'), native('a', 'b', 'c'), native('d', 'e')])
    expect(index.size).toBe(2)
    expect(index.holder(native('a', 'b', 'x'))?.path).toBe('/root/a/b')
    expect(index.holder(native('a', 'bb'))).toBeUndefined()
    expect(index.add(native('a'), 2)).toBe(true)
    expect(index.size).toBe(2)
    expect(index.add(native('f', 'g'), 2)).toBe(false)
    expect(index.size).toBe(2)
    expect(index.add(native('f', 'g'), 3)).toBe(true)
  })

  it('queues a thousand items onto a thousand queued items in well under a second', () => {
    for (const make of [
      (group: string, item: number) => native(group, `item-${item}`),
      (group: string, item: number) => target(`C:\\Data\\${group}\\item-${item}`),
    ]) {
      const queued = Array.from({ length: 1000 }, (_, item) => make('queued', item))
      const started = performance.now()
      const index = new QueueIndex(queued)
      const fresh = Array.from({ length: 1000 }, (_, item) => make(`new-${item % 10}`, item))
      let added = 0
      for (const next of fresh) if (!index.holder(next) && index.add(next, 2000)) added++
      // The app rebuilds an index from React state once per batch of 50.
      for (let batch = 0; batch < 20; batch++) new QueueIndex([...queued, ...fresh.slice(0, batch * 50)])
      const summary = summarizeStaged([...queued, ...fresh])
      const elapsed = performance.now() - started
      expect(added).toBe(1000)
      expect(summary.top).toHaveLength(2000)
      expect(elapsed).toBeLessThan(500)
    }
  })
})
