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

test('per-directory read error counts are validated, saved and decide partial-scan staging', async () => {
  const store = new Store(openDb(':memory:'))
  try {
    const machine = store.upsertMachine({
      id: 'fixture',
      kind: 'ssh',
      os: 'linux',
      name: 'Fixture',
      workerId: 'fixture',
      account: 'fixture',
    })
    const disk = store.addNativeDisk(machine.id, root)
    const name = (text: string) => ({ name: text, nameBytes: Buffer.from(text).toString('base64') })
    const dir = (id: number, parent: number | null, label: string, size: number, files: number, errors?: number) => ({
      t: 'dir',
      id,
      parent,
      ...(parent === null ? { name: root.path } : name(label)),
      size,
      files,
      ...(errors === undefined ? {} : { errors }),
      identity: { device: '1', inode: String(10 + id), mount: '3' },
      createdAt: null,
      lastWrittenAt: 1,
    })
    const partial = (errors: { root?: number; top?: number; keep?: number; bad?: number }, total = 1) =>
      [
        { t: 'root', root },
        dir(1, null, '', 3, 1, errors.root),
        dir(2, 1, 'top', 3, 1, errors.top),
        dir(3, 2, 'keep', 3, 1, errors.keep),
        {
          t: 'file',
          parent: 3,
          ...name('f'),
          size: 3,
          identity: { device: '1', inode: '20', mount: '3' },
          createdAt: null,
          lastWrittenAt: 1,
        },
        dir(4, 2, 'bad', 0, 0, errors.bad),
        { t: 'error', path: '/owned-fixture/top/bad/private', message: 'Permission denied' },
        { ...records[3]!, files: 1, dirs: 4, errors: total, coverage: 'partial' },
      ] as Exclude<WorkerFrame, { t: 'hello' }>[]
    const scan = (rows: Exclude<WorkerFrame, { t: 'hello' }>[]) => {
      vi.mocked(workerFrames).mockReturnValueOnce(
        (async function* () {
          yield* rows
        })(),
      )
      return runScan({
        store,
        scannerExe: 'unused',
        diskId: disk.id,
        minFileSize: 0,
        onProgress: () => {},
        signal: new AbortController().signal,
      })
    }
    for (const invalid of [
      // Only part of the tree reports counts.
      partial({ root: 1, top: 1, keep: 0 }),
      // A child reports more errors than its parent.
      partial({ root: 1, top: 0, keep: 0, bad: 1 }),
      // The root disagrees with the scan total.
      partial({ root: 2, top: 2, keep: 0, bad: 1 }),
    ])
      expect((await scan(invalid)).status).toBe('failed')

    const old = await scan(partial({}))
    expect(old.status).toBe('complete')
    store.setCleanupEnabled(disk.id, true)
    const node = (path: string[]) =>
      path.reduce(
        (parent, part) =>
          Number(store.db.prepare('SELECT id FROM node WHERE parent=? AND name=?').get(parent, part)!.id),
        disk.rootNode,
      )
    expect(() => store.stageDelete(disk.id, node(['top', 'keep']))).toThrow(/Update the worker and scan again/)

    const fresh = await scan(partial({ root: 1, top: 1, keep: 0, bad: 1 }))
    expect(fresh.status).toBe('complete')
    expect(store.stageDelete(disk.id, node(['top', 'keep']))).toMatchObject({ scanId: fresh.scanId, partialScan: true })
    expect(store.stageDelete(disk.id, node(['top', 'keep', 'f']))).toMatchObject({ partialScan: true })
    expect(() => store.stageDelete(disk.id, node(['top', 'bad']))).toThrow(/1 item at or under this path/)
  } finally {
    store.db.close()
  }
})
