import { parentPort, workerData } from 'node:worker_threads'
import type { ScanEvent } from '../shared/types'
import { runScan } from './scan'
import { openDb, Store } from './store'

export interface ScanWorkerData {
  dbFile: string
  scannerExe: string
  diskId: number
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
const outcome = await runScan({
  store,
  scannerExe: data.scannerExe,
  diskId: data.diskId,
  minFileSize: data.minFileSize,
  signal: controller.signal,
  onProgress: (progress) => post({ type: 'progress', progress }),
})
store.db.close()
post({ type: 'finished', diskId: data.diskId, status: outcome.status, message: outcome.message })
port.close()
