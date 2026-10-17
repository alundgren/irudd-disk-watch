import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { executeDelete, executeNativeDelete } from './scan'
import { Store, openDb } from './store'
import { workerOperation, WorkerRequestNotSent } from './worker'
import { DELETE_SCAN_MAX_AGE_MS } from '../shared/scanFreshness'
import type { TargetOS } from '../shared/types'

vi.mock('node:child_process', { spy: true })
vi.mock('./worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker')>()
  return { ...actual, workerOperation: vi.fn() }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
const NOW = 10_000_000
const encoded = (text: string) => Buffer.from(text).toString('base64')

function fixture(os: TargetOS) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const store = new Store(openDb(':memory:'))
  const machine = store.upsertMachine({
    id: 'fixture',
    name: 'Fixture',
    kind: 'local',
    os,
    workerId: 'worker',
    account: 'account',
  })
  const root = {
    path: '/fixture',
    pathBytes: encoded('/fixture'),
    identity: { device: '1', inode: '2' },
    filesystem: 'fixture',
    capacity: null,
    observedAt: NOW,
    readOnly: false,
  }
  const disk = os === 'windows' ? store.addDisk('C:\\Fixture', machine.id) : store.addNativeDisk(machine.id, root)
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', os === 'windows' ? undefined : encoded('nested'))
  const file = store.internNode(parent, 'file', 'file', os === 'windows' ? undefined : encoded('file'))
  if (os !== 'windows') store.setCleanupEnabled(disk.id, true)
  const scan = (startedAt = NOW) => {
    const id = store.beginScan(disk.id, [])
    store.db.prepare("UPDATE scan SET status='complete',started_at=?,finished_at=? WHERE id=?").run(startedAt, NOW, id)
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,10,1)').run(id, file)
    if (os !== 'windows') store.setEntryIdentity(id, file, { device: '1', inode: '3' })
    return id
  }
  const connection = { machine, scannerExe: 'must-not-run' }
  const execute = (targets: ReturnType<Store['stageDelete']>[], diskId = disk.id) =>
    os === 'windows'
      ? executeDelete(store, connection.scannerExe, diskId, targets)
      : executeNativeDelete(store, connection, diskId, targets)
  return { store, disk, file, scan, execute }
}

for (const os of ['windows', 'linux', 'macos'] as const) {
  test(`${os} staging accepts the threshold, while stale queues are rejected at execution`, async () => {
    const f = fixture(os)
    try {
      f.scan(NOW - DELETE_SCAN_MAX_AGE_MS)
      const target = f.store.stageDelete(f.disk.id, f.file)
      expect(target.nodeId).toBe(f.file)
      vi.mocked(Date.now).mockReturnValue(NOW + 1)
      expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
      await expect(f.execute([target])).rejects.toThrow(/Scan this root again/)
      expect(spawn).not.toHaveBeenCalled()
      expect(workerOperation).not.toHaveBeenCalled()
    } finally {
      f.store.db.close()
    }
  })

  test(`${os} missing and future scans fail, and a long scan remains stale at completion`, () => {
    const f = fixture(os)
    try {
      expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
      const id = f.scan(NOW + 1)
      expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
      f.store.db.prepare('UPDATE scan SET started_at=? WHERE id=?').run(NOW - DELETE_SCAN_MAX_AGE_MS - 1, id)
      expect(f.store.latestCompleteScan(f.disk.id)?.finishedAt).toBe(NOW)
      expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
      for (const invalid of [Infinity, -Infinity, 'invalid']) {
        f.store.db.prepare('UPDATE scan SET started_at=? WHERE id=?').run(invalid, id)
        expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
      }
      const fresh = f.scan(NOW)
      expect(f.store.stageDelete(f.disk.id, f.file).scanId).toBe(fresh)
    } finally {
      f.store.db.close()
    }
  })

  test(`${os} failed or cancelled scans and another root's fresh scan cannot renew freshness`, () => {
    const f = fixture(os)
    try {
      const old = f.scan(NOW - DELETE_SCAN_MAX_AGE_MS - 1)
      for (const status of ['failed', 'cancelled'] as const) {
        const unfinished = f.store.beginScan(f.disk.id, [])
        f.store.endScan(unfinished, status, status)
        expect(f.store.latestCompleteScan(f.disk.id)?.id).toBe(old)
      }
      const other = f.store.addDisk('D:\\Other')
      const id = f.store.beginScan(other.id, [])
      f.store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(id)
      expect(() => f.store.stageDelete(f.disk.id, f.file)).toThrow(/Scan this root again/)
    } finally {
      f.store.db.close()
    }
  })

  test(`${os} execution rejects a forged scan, wrong root and a queue from an earlier scan`, async () => {
    const f = fixture(os)
    try {
      f.scan()
      const target = f.store.stageDelete(f.disk.id, f.file)
      await expect(f.execute([{ ...target, scanId: target.scanId + 50 }])).rejects.toThrow(/changed/)
      await expect(f.execute([{ ...target, diskId: f.disk.id + 1 }])).rejects.toThrow(/changed/)
      const other = f.store.addDisk('D:\\Other')
      await expect(f.execute([target], other.id)).rejects.toThrow()
      vi.mocked(Date.now).mockReturnValue(NOW + 1)
      const newer = f.scan(NOW - 1)
      expect(f.store.latestCompleteScan(f.disk.id)?.id).toBe(newer)
      await expect(f.execute([target])).rejects.toThrow(/changed/)
      expect(spawn).not.toHaveBeenCalled()
      expect(workerOperation).not.toHaveBeenCalled()
    } finally {
      f.store.db.close()
    }
  })
}

test('expiry during native preflight rejects before sending and discards the unsent operation', async () => {
  const f = fixture('linux')
  try {
    f.scan(NOW - DELETE_SCAN_MAX_AGE_MS)
    const target = f.store.stageDelete(f.disk.id, f.file)
    vi.mocked(workerOperation).mockImplementationOnce(async (_connection, op, _payload, _signal, beforeSend) => {
      expect(op).toBe('delete')
      expect(beforeSend).toBeTypeOf('function')
      // Transport calls this guard only after its asynchronous capability probe.
      vi.mocked(Date.now).mockReturnValue(NOW + 1)
      try {
        beforeSend!()
      } catch (error) {
        throw new WorkerRequestNotSent((error as Error).message)
      }
      throw new Error('The expired request must not be sent')
    })
    await expect(f.execute([target])).rejects.toThrow(/Scan this root again/)
    expect(f.store.listDeleteOperations(f.disk.id)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    f.store.db.close()
  }
})

test('Windows rechecks freshness immediately before sending deletion paths', async () => {
  const f = fixture('windows')
  try {
    f.scan(NOW - DELETE_SCAN_MAX_AGE_MS)
    const target = f.store.stageDelete(f.disk.id, f.file)
    const input = new PassThrough()
    const end = vi.spyOn(input, 'end')
    const kill = vi.fn()
    const child = Object.assign(new EventEmitter(), {
      stdin: input,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill,
    })
    vi.mocked(spawn).mockImplementationOnce(() => {
      vi.mocked(Date.now).mockReturnValue(NOW + 1)
      return child as unknown as ReturnType<typeof spawn>
    })
    await expect(f.execute([target])).rejects.toThrow(/Scan this root again/)
    expect(end).toHaveBeenCalledOnce()
    expect(end).toHaveBeenCalledWith()
    expect(kill).toHaveBeenCalledOnce()
  } finally {
    f.store.db.close()
  }
})
