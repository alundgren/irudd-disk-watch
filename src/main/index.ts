import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { join, parse, relative, resolve } from 'node:path'
import type { DeleteResult, Disk, ScanEvent, ScanProgress, StagedDelete } from '../shared/types'
import { executeDelete } from './scan'
import type { ScanWorkerData } from './scanWorker'
import createScanWorker from './scanWorker?nodeWorker'
import { openDb, Store, type DiskRow } from './store'

const MIN_FILE_SIZE = 1024 * 1024

app.setName('Disk Watch')
app.setAppUserModelId('com.irudd.diskwatch')
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'disk-watch'))
}

const dbFile = join(app.getPath('userData'), 'disk-watch.db')
const iconFile = app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build/icon.ico')
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
let activeDelete: Promise<DeleteResult> | null = null

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
    hides: store.hideSettings(row.id),
  }
}

function send(event: ScanEvent) {
  window?.webContents.send('scan-event', event)
}

function startScan() {
  if (activeDelete) throw new Error('Wait for deletion to finish before scanning.')
  if (activeScan) throw new Error('A scan is already running')
  const diskIds = store.listDisks().map((disk) => disk.id)
  const [first] = diskIds
  if (first === undefined) return
  const workerData: ScanWorkerData = {
    dbFile,
    scannerExe,
    diskIds,
    minFileSize: MIN_FILE_SIZE,
    ...(process.env.DISK_WATCH_VERIFY === '1' ? { method: 'walk' } : {}),
  }
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
  ipcMain.handle('removeDisk', (_e, diskId: number) => {
    if (activeDelete) throw new Error('Wait for deletion to finish before removing a disk.')
    return store.removeDisk(diskId)
  })
  ipcMain.handle('pickExclude', async (_e, diskId: number, kind: 'file' | 'dir') => {
    const { root } = store.getDisk(diskId)
    if (kind !== 'file' && kind !== 'dir') throw new Error('Choose a file or folder exclusion.')
    const result = await dialog.showOpenDialog(window!, {
      title: `Choose a ${kind === 'file' ? 'file' : 'folder'} to exclude`,
      defaultPath: root,
      properties: [kind === 'file' ? 'openFile' : 'openDirectory', 'showHiddenFiles'],
    })
    const path = result.filePaths[0] ? resolve(result.filePaths[0]) : null
    if (path && !isInside(root, path)) throw new Error(`${path} is not inside ${root}`)
    return path
  })
  ipcMain.handle('setExcludes', (_e, diskId: number, paths: string[]) => store.setExcludes(diskId, paths))
  ipcMain.handle('addExclude', (_e, diskId: number, path: string) => store.addExclude(diskId, path))
  ipcMain.handle('openDisk', (_e, diskId: number) => {
    store.db.exec('BEGIN')
    try {
      const snapshot = { disk: toDisk(store.getDisk(diskId)), scans: store.listScans(diskId) }
      store.db.exec('COMMIT')
      return snapshot
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
  })
  ipcMain.handle('changeHides', (_e, diskId, change) => store.changeHides(diskId, change))
  ipcMain.handle('undoHides', (_e, undo) => store.undoHides(undo))
  ipcMain.handle('totals', (_e, scanId, revision) => store.totals(scanId, revision))
  ipcMain.handle('deleteScan', (_e, scanId: number) => {
    if (activeDelete) throw new Error('Wait for deletion to finish before removing a scan.')
    return store.deleteScan(scanId)
  })
  ipcMain.handle('startScan', () => startScan())
  ipcMain.handle('cancelScan', () => activeScan?.worker.postMessage('cancel'))
  ipcMain.handle('currentScan', () => activeScan?.progress ?? null)
  ipcMain.handle('children', (_e, scanId: number, nodeId: number, revision?: number) =>
    store.children(scanId, nodeId, revision),
  )
  ipcMain.handle('diffChildren', (_e, from: number, to: number, nodeId: number, revision?: number) =>
    store.diffChildren(from, to, nodeId, revision),
  )
  ipcMain.handle('compare', (_e, from: number, to: number, revision: number) => store.compare(from, to, revision))
  ipcMain.handle('nodePath', (_e, nodeId: number) => store.nodePath(nodeId))
  ipcMain.handle('stageDelete', (_e, diskId: number, nodeId: number) => store.stageDelete(diskId, nodeId))
  ipcMain.handle('executeDelete', async (_e, diskId: number, targets: StagedDelete[]) => {
    if (activeScan) throw new Error('Wait for the scan to finish before deleting.')
    if (activeDelete) throw new Error('A deletion is already running.')
    const operation = executeDelete(store, scannerExe, diskId, targets)
    activeDelete = operation
    try {
      return await operation
    } finally {
      activeDelete = null
    }
  })
  ipcMain.handle('showInExplorer', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('isElevated', () => elevated)
  ipcMain.handle('restartElevated', () => restartElevated())
}

function createWindow() {
  window = new BrowserWindow({
    show: process.env.DISK_WATCH_VERIFY !== '1',
    width: 1280,
    height: 820,
    title: 'Disk Watch',
    icon: iconFile,
    backgroundColor: '#f2eade',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      ...(process.env.DISK_WATCH_VERIFY === '1' ? { offscreen: true, backgroundThrottling: false } : {}),
    },
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
  if (activeDelete) {
    event.preventDefault()
    activeDelete.then(
      () => app.quit(),
      () => app.quit(),
    )
    return
  }
  if (!activeScan) return
  event.preventDefault()
  activeScan.worker.once('exit', () => app.quit())
  activeScan.worker.postMessage('cancel')
})
