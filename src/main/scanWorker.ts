import { parentPort, workerData } from 'node:worker_threads'
import type { ScanEvent, ScanMethod } from '../shared/types'
import { runScan } from './scan'
import { openDb, Store } from './store'
import { nativeRoot } from '../shared/workerProtocol'
import { workerOperation } from './worker'

export interface ScanWorkerData {
  dbFile: string
  scannerExe: string
  stateDir?: string
  diskIds: number[]
  minFileSize: number
  method?: Exclude<ScanMethod, 'incremental'>
  incremental?: boolean
}

const data = workerData as ScanWorkerData
const port = parentPort!
const controller = new AbortController()
port.on('message', (message) => {
  if (message === 'cancel') controller.abort()
})

const store = new Store(openDb(data.dbFile))
const post = (event: ScanEvent) => port.postMessage(event)
const diskIds = [...new Set(data.diskIds)]
  .map((diskId) => store.getDisk(diskId))
  .filter((disk) => disk.machine.kind !== 'historical' && disk.scanIncluded)
  .map((disk) => disk.id)
const count = diskIds.length
for (const [index, diskId] of diskIds.entries()) {
  if (controller.signal.aborted) break
  post({ type: 'progress', progress: { diskId, index, count, phase: 'starting' } })
  const outcome = await runScan({
    store,
    scannerExe: data.scannerExe,
    stateDir: data.stateDir,
    diskId,
    minFileSize: data.minFileSize,
    method: data.method,
    incremental: data.incremental,
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', progress: { diskId, index, count, ...progress } }),
  })
  const disk = store.getDisk(diskId)
  if (outcome.status === 'complete' && disk.targetOS === 'windows' && disk.machine.workerId) {
    try {
      const observed = nativeRoot(
        await workerOperation(
          { machine: disk.machine, scannerExe: data.scannerExe, stateDir: data.stateDir },
          'inspect',
          { path: disk.root },
          controller.signal,
        ),
      )
      store.db.prepare('UPDATE disk SET native_root=? WHERE id=?').run(JSON.stringify(observed), diskId)
    } catch {
      /* A capacity refresh cannot invalidate a completed MFT scan. Cached observations retain their time. */
    }
  }
  post({ type: 'disk-finished', diskId, status: outcome.status, message: outcome.message })
}
store.db.close()
post({ type: 'run-finished' })
port.close()
