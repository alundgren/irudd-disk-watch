import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { openDb, Store } from './store'
import type { ScanWorkerData } from './scanWorker'

const state = vi.hoisted(() => ({ data: {} as ScanWorkerData, post: vi.fn(), close: vi.fn(), scan: vi.fn() }))
vi.mock('node:worker_threads', () => ({
  get workerData() {
    return state.data
  },
  parentPort: { on: vi.fn(), postMessage: state.post, close: state.close },
}))
vi.mock('./scan', () => ({ runScan: state.scan }))
afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

test.each([false, true])(
  'scan worker reads only included live roots, sequentially, incremental=%s',
  async (incremental) => {
    const directory = mkdtempSync(join(tmpdir(), 'dw-selected-run-'))
    const dbFile = join(directory, 'history.db')
    const store = new Store(openDb(dbFile))
    try {
      const machine = store.upsertMachine({ id: 'live', kind: 'local', os: 'windows', name: 'Fixture' })
      const first = store.addDisk('C:\\First', machine.id)
      const excluded = store.addDisk('D:\\Excluded', machine.id)
      const last = store.addDisk('E:\\Last', machine.id)
      const history = store.addDisk('F:\\History')
      for (const disk of [first, excluded, last, history]) {
        const id = store.beginScan(disk.id, [])
        store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(id)
      }
      const saved = store.listScans(excluded.id)
      store.setScanIncluded(excluded.id, false)
      state.data = {
        dbFile,
        scannerExe: 'unused',
        diskIds: [first.id, excluded.id, last.id, history.id],
        minFileSize: 0,
        incremental,
      }
      let inFlight = 0
      state.scan.mockImplementation(async (options) => {
        expect(inFlight++).toBe(0)
        await new Promise((resolve) => setTimeout(resolve, 1))
        const scanId = options.store.beginScan(options.diskId, [])
        options.store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(scanId)
        inFlight--
        return { scanId, status: 'complete' }
      })
      await import('./scanWorker')
      expect(state.scan.mock.calls.map(([options]) => options.diskId)).toEqual([first.id, last.id])
      expect(state.scan.mock.calls.every(([options]) => options.incremental === incremental)).toBe(true)
      expect(store.listScans(excluded.id)).toEqual(saved)
      expect(store.listScans(history.id)).toHaveLength(1)
      expect(state.post).toHaveBeenLastCalledWith({ type: 'run-finished' })
      expect(state.close).toHaveBeenCalledOnce()
    } finally {
      store.db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
