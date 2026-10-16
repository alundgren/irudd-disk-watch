import { expect, test, vi } from 'vite-plus/test'
import { Store, openDb } from './store'
import { runScan } from './scan'
import { workerFrames } from './worker'
import type { WorkerFrame } from '../shared/workerProtocol'

vi.mock('./worker.ts', () => ({ workerFrames: vi.fn(), workerOperation: vi.fn() }))

const root = {
  path: '/owned-fixture',
  pathBytes: Buffer.from('/owned-fixture').toString('base64'),
  identity: { device: '1', inode: '2', mount: '3' },
  filesystem: 'fixture',
  capacity: null,
  observedAt: 1,
  readOnly: false,
}
const records: Exclude<WorkerFrame, { t: 'hello' }>[] = [
  { t: 'root', root },
  {
    t: 'dir',
    id: 1,
    parent: null,
    name: root.path,
    size: 3,
    files: 1,
    identity: root.identity,
    createdAt: null,
    lastWrittenAt: 1,
  },
  {
    t: 'file',
    parent: 1,
    name: 'a',
    nameBytes: 'YQ==',
    size: 3,
    identity: { device: '1', inode: '4', mount: '3' },
    createdAt: null,
    lastWrittenAt: 1,
  },
  {
    t: 'done',
    size: 3,
    files: 1,
    dirs: 1,
    errors: 0,
    ms: 1,
    method: 'walk',
    fallback: null,
    coverage: 'complete',
    policy: 'regular-files-single-mount-no-symlink-traversal',
    skipped: { symlinks: 0, special: 0, mounts: 0 },
  },
]

test('native ingestion rolls back a failed exit, missing terminal, and invalid totals after retaining the old scan', async () => {
  const store = new Store(openDb(':memory:'))
  try {
    const machine = store.upsertMachine({
      id: 'fixture',
      kind: 'local',
      os: 'linux',
      name: 'Fixture',
      workerId: 'fixture',
      account: 'fixture',
    })
    const disk = store.addNativeDisk(machine.id, root)
    const scan = () =>
      runScan({
        store,
        scannerExe: 'unused',
        diskId: disk.id,
        minFileSize: 0,
        onProgress: () => {},
        signal: new AbortController().signal,
      })
    const stream = (rows: typeof records, failure = false) =>
      (async function* () {
        yield* rows
        if (failure) throw new Error('Worker exit 1 after done')
      })()
    vi.mocked(workerFrames).mockReturnValueOnce(stream(records))
    const complete = await scan()
    expect(complete.status).toBe('complete')
    for (const invalid of [
      stream(records, true),
      stream(records.slice(0, -1)),
      stream([...records.slice(0, -1), { ...records[3]!, size: 99 } as (typeof records)[number]]),
    ]) {
      vi.mocked(workerFrames).mockReturnValueOnce(invalid)
      const failed = await scan()
      expect(failed.status).toBe('failed')
      expect(store.latestCompleteScan(disk.id)?.id).toBe(complete.scanId)
      expect(store.db.prepare('SELECT count(*) AS count FROM entry WHERE scan_id=?').get(failed.scanId)?.count).toBe(0)
      expect(store.children(complete.scanId, disk.rootNode).map((row) => row.name)).toEqual(['a'])
    }
  } finally {
    store.db.close()
  }
})
