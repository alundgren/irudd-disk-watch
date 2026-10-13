import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { join, parse, relative, resolve } from 'node:path'
import type { Disk, ScanEvent, ScanProgress } from '../shared/types'
import type { ScanWorkerData } from './scanWorker'
import createScanWorker from './scanWorker?nodeWorker'
import { openDb, Store, type DiskRow } from './store'

const MIN_FILE_SIZE = 1024 * 1024

const dbFile = join(app.getPath('userData'), 'disk-watch.db')
const scannerExe = app.isPackaged
  ? join(process.resourcesPath, 'dw-scan.exe')
  : join(app.getAppPath(), 'scanner/target/release/dw-scan.exe')

let store: Store
let window: BrowserWindow | null = null
interface ActiveScan {
  worker: ReturnType<typeof createScanWorker>
  progress: ScanProgress
}

let activeScan: ActiveScan | null = null

function capacity(root: string): Disk['capacity'] {
  try {
    const stats = statfsSync(root)
    return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }
  } catch {
    return null
  }
}

function toDisk(row: DiskRow): Disk {
  return {
    ...row,
    excludes: store.excludes(row.id),
    latestScan: store.latestCompleteScan(row.id),
    capacity: capacity(row.root),
  }
}

function send(event: ScanEvent) {
  window?.webContents.send('scan-event', event)
}

function startScan() {
  if (activeScan) throw new Error('A scan is already running')
  const diskIds = store.listDisks().map((disk) => disk.id)
  const [first] = diskIds
  if (first === undefined) return
  const workerData: ScanWorkerData = { dbFile, scannerExe, diskIds, minFileSize: MIN_FILE_SIZE }
  const scan: ActiveScan = {
    worker: createScanWorker({ workerData }),
    progress: { diskId: first, index: 0, count: diskIds.length, phase: 'starting' },
  }
  activeScan = scan
  scan.worker.on('message', (event: ScanEvent) => {
    if (event.type === 'progress') scan.progress = event.progress
    if (event.type === 'run-finished') activeScan = null
    send(event)
  })
  scan.worker.on('error', (err) => {
    activeScan = null
    send({ type: 'disk-finished', diskId: scan.progress.diskId, status: 'failed', message: err.message })
    send({ type: 'run-finished' })
  })
}

// S-1-16-12288 is the high integrity level that an elevated process runs at.
const elevated = new Promise<boolean>((done) =>
  execFile('whoami', ['/groups'], (err, stdout) => done(!err && stdout.includes('S-1-16-12288'))),
)

/** Starts an elevated copy of the built app through UAC, then quits this one. */
async function restartElevated() {
  if (process.env.ELECTRON_RENDERER_URL) {
    throw new Error('Restarting as administrator needs the built app. Run "npm run app" instead.')
  }
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
  const args = app.isPackaged ? '' : ` -ArgumentList ${quote(`"${app.getAppPath()}"`)}`
  await new Promise<void>((done, fail) =>
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process -FilePath ${quote(process.execPath)}${args} -Verb RunAs`],
      (err) => (err ? fail(new Error('Windows did not start Disk Watch as administrator.')) : done()),
    ),
  )
  app.quit()
}

function isInside(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && parse(rel).root === ''
}

async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(window!, { title, defaultPath, properties: ['openDirectory'] })
  const path = result.filePaths[0]
  return path ? resolve(path) : null
}

function registerIpc() {
  ipcMain.handle('listDisks', () => store.listDisks().map(toDisk))
  ipcMain.handle('pickAndAddDisk', async () => {
    const path = await pickFolder('Choose a drive or folder to track')
    return path ? toDisk(store.addDisk(path)) : null
  })
  ipcMain.handle('removeDisk', (_e, diskId: number) => store.removeDisk(diskId))
  ipcMain.handle('pickExclude', async (_e, diskId: number) => {
    const { root } = store.getDisk(diskId)
    const path = await pickFolder('Choose a folder to exclude', root)
    if (path && !isInside(root, path)) throw new Error(`${path} is not inside ${root}`)
    return path
  })
  ipcMain.handle('setExcludes', (_e, diskId: number, paths: string[]) => store.setExcludes(diskId, paths))
  ipcMain.handle('listScans', (_e, diskId: number) => store.listScans(diskId))
  ipcMain.handle('deleteScan', (_e, scanId: number) => store.deleteScan(scanId))
  ipcMain.handle('startScan', () => startScan())
  ipcMain.handle('cancelScan', () => activeScan?.worker.postMessage('cancel'))
  ipcMain.handle('currentScan', () => activeScan?.progress ?? null)
  ipcMain.handle('children', (_e, scanId: number, nodeId: number) => store.children(scanId, nodeId))
  ipcMain.handle('diffChildren', (_e, from: number, to: number, nodeId: number) => store.diffChildren(from, to, nodeId))
  ipcMain.handle('changes', (_e, from: number, to: number) => store.changes(from, to))
  ipcMain.handle('nodePath', (_e, nodeId: number) => store.nodePath(nodeId))
  ipcMain.handle('showInExplorer', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('isElevated', () => elevated)
  ipcMain.handle('restartElevated', () => restartElevated())
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Disk Watch',
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs') },
  })
  window.on('closed', () => (window = null))
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  store = new Store(openDb(dbFile))
  store.failInterruptedScans()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => app.quit())

// Quitting mid-scan would orphan dw-scan.exe, so cancel and wait for the worker to clean up.
app.on('before-quit', (event) => {
  if (!activeScan) return
  event.preventDefault()
  activeScan.worker.once('exit', () => app.quit())
  activeScan.worker.postMessage('cancel')
})
