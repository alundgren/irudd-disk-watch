import { parentPort, workerData } from 'node:worker_threads'
import type { ScanEvent } from '../shared/types'
import { runScan } from './scan'
import { openDb, Store } from './store'

export interface ScanWorkerData {
  dbFile: string
  scannerExe: string
  diskIds: number[]
  minFileSize: number
}

const data = workerData as ScanWorkerData
const port = parentPort!
const controller = new AbortController()
port.on('message', (message) => {
  if (message === 'cancel') controller.abort()
})

const store = new Store(openDb(data.dbFile))
const post = (event: ScanEvent) => port.postMessage(event)
const count = data.diskIds.length
for (const [index, diskId] of data.diskIds.entries()) {
  if (controller.signal.aborted) break
  post({ type: 'progress', progress: { diskId, index, count, phase: 'starting' } })
  const outcome = await runScan({
    store,
    scannerExe: data.scannerExe,
    diskId,
    minFileSize: data.minFileSize,
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', progress: { diskId, index, count, ...progress } }),
  })
  post({ type: 'disk-finished', diskId, status: outcome.status, message: outcome.message })
}
store.db.close()
post({ type: 'run-finished' })
port.close()
