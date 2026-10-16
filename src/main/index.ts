import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DeleteResult,
  Disk,
  HideChange,
  Machine,
  NativeRoot,
  NativeVolume,
  PathRule,
  ScanEvent,
  ScanProgress,
  StagedDelete,
  TargetOS,
} from '../shared/types'
import { bytes, nativeIdentity, nativeRoot, object, workerInfo } from '../shared/workerProtocol'
import { executeDelete, executeNativeDelete, recoverNativeDelete } from './scan'
import { bindWorker, workerOperation, type WorkerConnection } from './worker'
import type { ScanWorkerData } from './scanWorker'
import createScanWorker from './scanWorker?nodeWorker'
import { openDb, Store, LEGACY_WINDOWS_MACHINE_ID, type DiskRow } from './store'
import { prepareHistory } from './history'
import { absoluteFolderPath, selectedVolume, verifyVolume, volumeDiscovery } from './volumes'

const MIN_FILE_SIZE = 1024 * 1024
const hostOS: TargetOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
app.setName('Disk Watch')
app.setAppUserModelId('com.irudd.diskwatch')
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'disk-watch'))
const ownsProfile = app.requestSingleInstanceLock()
if (!ownsProfile) app.quit()
const stateDir = join(app.getPath('userData'), 'native-worker')
let dbFile: string
const resources = app.isPackaged ? process.resourcesPath : app.getAppPath()
const iconFile = app.isPackaged
  ? join(resources, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  : join(resources, 'build/icon.png')
const scannerExe = app.isPackaged
  ? join(resources, process.platform === 'win32' ? 'dw-scan.exe' : 'dw-scan')
  : join(resources, 'scanner/target/release', process.platform === 'win32' ? 'dw-scan.exe' : 'dw-scan')
let store: Store
let window: BrowserWindow | null = null
interface ActiveScan {
  worker: ReturnType<typeof createScanWorker>
  progress: ScanProgress
}
let activeScan: ActiveScan | null = null
let activeDelete: Promise<DeleteResult> | null = null
let localMachine: Promise<Machine> | undefined
let restarting = false
let activeSetup = false
const discoveredVolumes = new Map<string, NativeVolume[]>()

function connection(machine: Machine): WorkerConnection {
  return { machine, scannerExe, stateDir }
}
function connectionFor(diskId: number): WorkerConnection {
  return connection(store.getDisk(diskId).machine)
}
function toDisk(row: DiskRow): Disk {
  const latestScan = store.latestCompleteScan(row.id)
  const captured = latestScan?.rootObservation
  const configured = row.nativeRoot
  const observed =
    captured &&
    configured &&
    captured.pathBytes === configured.pathBytes &&
    captured.identity.device === configured.identity.device &&
    captured.identity.inode === configured.identity.inode &&
    captured.identity.mount === configured.identity.mount &&
    captured.observedAt >= configured.observedAt
      ? captured
      : (configured ?? captured)
  return {
    ...row,
    nativeRoot: observed,
    excludes: store.excludes(row.id),
    excludeRules: store.excludeRules(row.id),
    latestScan,
    capacity: observed?.capacity ?? null,
    hides: store.hideSettings(row.id),
  }
}
function send(event: ScanEvent) {
  window?.webContents.send('scan-event', event)
}
function idle() {
  if (activeScan || activeDelete || restarting || activeSetup)
    throw new Error('Wait for the current filesystem operation to finish.')
}
async function setupOperation<T>(run: () => Promise<T>): Promise<T> {
  idle()
  activeSetup = true
  try {
    return await run()
  } finally {
    activeSetup = false
  }
}
async function ensureLocalMachine(): Promise<Machine> {
  localMachine ??= (async () => {
    const provisional: Machine = {
      id: 'local',
      kind: 'local',
      os: hostOS,
      name: `This ${hostOS === 'macos' ? 'Mac' : hostOS === 'windows' ? 'Windows PC' : 'computer'}`,
    }
    const observed = workerInfo(await workerOperation(connection(provisional), 'hello'))
    if (hostOS === 'windows')
      return store.upsertMachine({ ...store.bindLegacyWindowsMachine(observed), name: 'This Windows PC' })
    const current = { ...bindWorker(provisional, observed), id: `local-${observed.id}` }
    return store.upsertMachine(current)
  })().catch((error) => {
    localMachine = undefined
    throw error
  })
  return localMachine
}
async function inspectRoot(machine: Machine, path: string) {
  return nativeRoot(await workerOperation(connection(machine), 'inspect', { path }))
}
async function connectSshMachine(destination: string): Promise<Machine> {
  if (typeof destination !== 'string') throw new Error('Enter an SSH destination.')
  const provisional: Machine = { id: randomUUID(), kind: 'ssh', os: 'linux', name: destination, destination }
  const observed = workerInfo(await workerOperation(connection(provisional), 'hello'))
  const existing = store
    .listMachines()
    .find(
      (machine) => machine.kind === 'ssh' && machine.workerId === observed.id && machine.account === observed.account,
    )
  return store.upsertMachine(bindWorker(existing ? { ...existing, destination } : provisional, observed))
}
function addObservedRoot(machine: Machine, observed: NativeRoot): Disk {
  const disk =
    machine.os === 'windows' ? store.addDisk(observed.path, machine.id) : store.addNativeDisk(machine.id, observed)
  if (machine.os === 'windows')
    store.db.prepare('UPDATE disk SET native_root=? WHERE id=?').run(JSON.stringify(observed), disk.id)
  return toDisk(store.getDisk(disk.id))
}
function assertBinding(disk: DiskRow): void {
  const current = store.getDisk(disk.id)
  if (
    current.rootNode !== disk.rootNode ||
    current.machineId !== disk.machineId ||
    current.machine.workerId !== disk.machine.workerId ||
    current.machine.account !== disk.machine.account ||
    JSON.stringify(current.nativeRoot) !== JSON.stringify(disk.nativeRoot)
  )
    throw new Error('The root binding changed while the operation was running. Try again against the current root.')
}
async function resolveRule(diskId: number, path?: string, components?: string[]): Promise<PathRule> {
  const disk = store.getDisk(diskId)
  if (!disk.nativeRoot) throw new Error('This root has no native observation.')
  const value = object(
    await workerOperation(connection(disk.machine), 'resolve', {
      root: disk.nativeRoot,
      ...(components ? { components } : { path }),
    }),
  )
  assertBinding(disk)
  if (typeof value.path !== 'string' || !Array.isArray(value.components))
    throw new Error('Invalid native path resolution.')
  const parts = value.components.map((part) => bytes(part, true))
  nativeIdentity(value.identity)
  if (!['file', 'dir'].includes(String(value.kind))) throw new Error('Unsupported native file kind.')
  return { path: value.path, components: parts }
}
async function startScan(mode: 'full' | 'incremental' = 'full') {
  if (mode !== 'full' && mode !== 'incremental') throw new Error('Choose a full or quick scan.')
  idle()
  if (hostOS === 'windows' && store.listDisks().some((disk) => disk.machineId === LEGACY_WINDOWS_MACHINE_ID))
    await ensureLocalMachine()
  idle()
  const disks = store.listDisks().filter((disk) => disk.machine.kind !== 'historical')
  const diskIds = disks.map((disk) => disk.id)
  const first = diskIds[0]
  if (first === undefined)
    throw new Error('Track a local or SSH folder before scanning. Historical scans remain available.')
  const workerData: ScanWorkerData = {
    dbFile,
    scannerExe,
    stateDir,
    diskIds,
    minFileSize: MIN_FILE_SIZE,
    incremental: mode === 'incremental',
    ...(process.env.DISK_WATCH_VERIFY === '1' ? { method: 'walk' } : {}),
  }
  const scan: ActiveScan = {
    worker: createScanWorker({ workerData }),
    progress: { diskId: first, index: 0, count: diskIds.length, phase: 'starting' },
  }
  activeScan = scan
  scan.worker.on('message', (event: ScanEvent) => {
    if (activeScan !== scan) return
    if (event.type === 'progress') scan.progress = event.progress
    if (event.type === 'run-finished') activeScan = null
    send(event)
  })
  scan.worker.on('error', (error) => {
    if (activeScan !== scan) return
    activeScan = null
    send({ type: 'disk-finished', diskId: scan.progress.diskId, status: 'failed', message: error.message })
    send({ type: 'run-finished' })
  })
}
const elevated =
  hostOS === 'windows'
    ? new Promise<boolean>((done) =>
        execFile('whoami', ['/groups'], (error, output) => done(!error && output.includes('S-1-16-12288'))),
      )
    : Promise.resolve(true)
async function restartElevated() {
  idle()
  if (hostOS !== 'windows') throw new Error('Administrator restart is available on Windows.')
  if (process.env.ELECTRON_RENDERER_URL) throw new Error('Build the app before restarting as administrator.')
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  const windowsQuote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
  const argumentsText = [...(app.isPackaged ? [] : [app.getAppPath()]), `--user-data-dir=${app.getPath('userData')}`]
    .map(windowsQuote)
    .join(' ')
  restarting = true
  app.releaseSingleInstanceLock()
  try {
    await new Promise<void>((done, reject) =>
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ErrorActionPreference='Stop'; Start-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(argumentsText)} -Verb RunAs -ErrorAction Stop`,
        ],
        (error) => (error ? reject(new Error('Windows did not start Disk Watch as administrator.')) : done()),
      ),
    )
  } catch (error) {
    restarting = false
    // UAC cancellation leaves this app usable when it still owns the profile.
    if (!app.requestSingleInstanceLock()) app.quit()
    throw error
  }
  app.quit()
}
function registerIpc() {
  ipcMain.handle('listDisks', () => store.listDisks().map(toDisk))
  ipcMain.handle('discoverVolumes', (_event, destination?: string) =>
    setupOperation(async () => {
      const machine = destination === undefined ? await ensureLocalMachine() : await connectSshMachine(destination)
      // A failed refresh must not leave old rows eligible for registration.
      discoveredVolumes.delete(machine.id)
      let result
      try {
        result = volumeDiscovery(await workerOperation(connection(machine), 'volumes'), machine.os)
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unsupported worker operation'))
          throw new Error('This worker cannot list drives. Install the worker matching this app, then refresh.')
        throw error
      }
      discoveredVolumes.set(machine.id, result.volumes)
      return { ...result, machine }
    }),
  )
  ipcMain.handle('addVolume', (_event, machineId: string, candidate: NativeVolume) =>
    setupOperation(async () => {
      const machine = store.getMachine(machineId)
      const volume = selectedVolume(discoveredVolumes.get(machineId) ?? [], candidate)
      const observed = nativeRoot(
        await workerOperation(
          connection(machine),
          'inspect',
          machine.os === 'windows' ? { path: volume.path } : { pathBytes: volume.pathBytes },
        ),
      )
      verifyVolume(volume, observed)
      return addObservedRoot(machine, observed)
    }),
  )
  ipcMain.handle('addFolder', (_event, machineId: string, path: string) =>
    setupOperation(async () => {
      const machine = store.getMachine(machineId)
      return addObservedRoot(machine, await inspectRoot(machine, absoluteFolderPath(path, machine.os)))
    }),
  )
  ipcMain.handle('scanIssues', (_event, scanId: number) => store.scanIssues(scanId))
  ipcMain.handle('removeDisk', (_event, diskId: number) => {
    idle()
    return store.removeDisk(diskId)
  })
  ipcMain.handle('pickExclude', async (_event, diskId: number, kind: 'file' | 'dir') => {
    const disk = store.getDisk(diskId)
    if (disk.machine.kind !== 'local') throw new Error('Enter a remote path or use a captured row context menu.')
    if (kind !== 'file' && kind !== 'dir') throw new Error('Choose a file or folder exclusion.')
    return (
      (
        await dialog.showOpenDialog(window!, {
          title: `Choose a ${kind === 'file' ? 'file' : 'folder'} to exclude`,
          defaultPath: disk.root,
          properties: [kind === 'file' ? 'openFile' : 'openDirectory', 'showHiddenFiles'],
        })
      ).filePaths[0] ?? null
    )
  })
  ipcMain.handle('setExcludes', (_event, diskId: number, paths: string[]) => {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new Error('Invalid exclusions.')
    const disk = store.getDisk(diskId)
    if (disk.targetOS === 'windows') return store.setExcludes(diskId, paths)
    const existing = store.excludeRules(diskId)
    const retained = paths.map((path) => {
      const rule = existing.find((rule) => rule.path === path)
      if (!rule) throw new Error('Resolve a new native exclusion before saving it.')
      return rule
    })
    return store.setExcludeRules(diskId, retained)
  })
  ipcMain.handle('addExclude', (_event, diskId: number, path: string) =>
    setupOperation(async () => {
      if (store.getDisk(diskId).targetOS === 'windows') return store.addExclude(diskId, path)
      return store.addExcludeRule(diskId, await resolveRule(diskId, path))
    }),
  )
  ipcMain.handle('addExcludeNode', (_event, diskId: number, nodeId: number) => {
    const location = store.nodeLocation(nodeId)
    if (location.diskId !== diskId) throw new Error('This node belongs to another root.')
    if (store.getDisk(diskId).targetOS === 'windows') store.addExclude(diskId, location.path)
    else store.addExcludeRule(diskId, location)
    return location.path
  })
  ipcMain.handle('openDisk', (_event, diskId: number) => {
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
  ipcMain.handle('changeHides', (_event, diskId: number, change: HideChange) =>
    setupOperation(async () => {
      if (store.getDisk(diskId).targetOS === 'windows' || change.type === 'metadata')
        return store.changeHides(diskId, change)
      const existing = store.hideSettings(diskId).rules?.find((rule) => rule.path === change.path)
      const selected = change.components
        ? { path: change.path, components: change.components }
        : (existing ?? (await resolveRule(diskId, change.path)))
      if (change.type === 'replace') {
        const replacement = change.replacementComponents
          ? { path: change.replacement, components: change.replacementComponents }
          : await resolveRule(diskId, change.replacement)
        return store.changeHides(diskId, {
          ...change,
          ...selected,
          replacement: replacement.path,
          replacementComponents: replacement.components,
        })
      }
      return store.changeHides(diskId, { ...change, ...selected })
    }),
  )
  ipcMain.handle('undoHides', (_event, undo) => store.undoHides(undo))
  ipcMain.handle('totals', (_event, scanId, revision) => store.totals(scanId, revision))
  ipcMain.handle('deleteScan', (_event, scanId: number) => {
    idle()
    return store.deleteScan(scanId)
  })
  ipcMain.handle('startScan', (_event, mode) => startScan(mode))
  ipcMain.handle('cancelScan', () => activeScan?.worker.postMessage('cancel'))
  ipcMain.handle('currentScan', () => activeScan?.progress ?? null)
  ipcMain.handle('openFullDiskAccessSettings', async () => {
    if (process.platform !== 'darwin') throw new Error('Full Disk Access settings are available only on this Mac.')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })
  ipcMain.handle('children', (_event, scanId, nodeId, revision) => store.children(scanId, nodeId, revision))
  ipcMain.handle('search', (_event, scanId, query) => store.search(scanId, query))
  ipcMain.handle('diffChildren', (_event, from, to, nodeId, revision) => store.diffChildren(from, to, nodeId, revision))
  ipcMain.handle('compare', (_event, from, to, revision) => store.compare(from, to, revision))
  ipcMain.handle('nodePath', (_event, nodeId) => store.nodePath(nodeId))
  ipcMain.handle('nodeLocation', (_event, nodeId) => store.nodeLocation(nodeId))
  ipcMain.handle('stageDelete', (_event, diskId, nodeId) => store.stageDelete(diskId, nodeId))
  ipcMain.handle('copyText', (_event, text: string) => {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text.')
    clipboard.writeText(text)
  })
  ipcMain.handle('reinspectRoot', (_event, diskId: number) =>
    setupOperation(async () => {
      const disk = store.getDisk(diskId)
      if (disk.targetOS === 'windows' || disk.machine.kind === 'historical' || !disk.nativeRoot)
        throw new Error('Choose a live native root to reinspect.')
      const observed = nativeRoot(
        await workerOperation(connection(disk.machine), 'inspect', { pathBytes: disk.nativeRoot.pathBytes }),
      )
      const policy = object(
        await workerOperation(connection(disk.machine), 'cleanup', { root: observed, enabled: false }),
      )
      if (policy.enabled !== false) throw new Error('Native cleanup could not be disabled for the reinspected root.')
      assertBinding(disk)
      store.refreshNativeRoot(diskId, observed)
      return toDisk(store.getDisk(diskId))
    }),
  )
  ipcMain.handle('setCleanupEnabled', (_event, diskId: number, enabled: boolean) =>
    setupOperation(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid cleanup preference.')
      const disk = store.getDisk(diskId)
      if (disk.targetOS === 'windows' || !disk.nativeRoot) throw new Error('Unix cleanup requires a native root.')
      const result = object(
        await workerOperation(connection(disk.machine), 'cleanup', { root: disk.nativeRoot, enabled }),
      )
      assertBinding(disk)
      if (result.enabled !== enabled) throw new Error('Native cleanup preference did not match.')
      store.setCleanupEnabled(diskId, enabled)
    }),
  )
  ipcMain.handle('executeDelete', async (_event, diskId: number, targets: StagedDelete[]) => {
    idle()
    if (!Array.isArray(targets)) throw new Error('Invalid deletion targets.')
    const disk = store.getDisk(diskId)
    if (disk.machine.kind !== 'local' && disk.targetOS === 'windows')
      throw new Error('Historical Windows roots cannot be deleted on this machine.')
    const operation =
      disk.targetOS === 'windows'
        ? executeDelete(store, scannerExe, diskId, targets)
        : executeNativeDelete(store, connectionFor(diskId), diskId, targets)
    activeDelete = operation
    try {
      return await operation
    } finally {
      activeDelete = null
    }
  })
  ipcMain.handle('deleteOperations', (_event, diskId) => store.listDeleteOperations(diskId))
  ipcMain.handle('recoverDelete', async (_event, operationId: string) => {
    idle()
    const saved = store.getDeleteOperation(operationId)
    const operation = recoverNativeDelete(store, connectionFor(saved.diskId), operationId)
    activeDelete = operation
    try {
      return await operation
    } finally {
      activeDelete = null
    }
  })
  ipcMain.handle('showNode', async (_event, diskId: number, nodeId: number) => {
    const disk = store.getDisk(diskId)
    const location = store.nodeLocation(nodeId)
    if (location.diskId !== diskId) throw new Error('The node belongs to another machine/root.')
    if (disk.machine.kind !== 'local' || disk.targetOS !== hostOS) {
      clipboard.writeText(location.path)
      return
    }
    if (disk.targetOS === 'windows') {
      shell.showItemInFolder(location.path)
      return
    }
    await resolveRule(diskId, undefined, location.components)
    const raw = Buffer.concat([
      Buffer.from(disk.nativeRoot!.pathBytes, 'base64'),
      ...location.components.flatMap((component) => [Buffer.from('/'), Buffer.from(component, 'base64')]),
    ])
    const path = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    if (!Buffer.from(path).equals(raw))
      throw new Error('The desktop shell cannot reveal this native byte path. Copy its displayed path instead.')
    shell.showItemInFolder(path)
  })
  ipcMain.handle('showInExplorer', () => {
    throw new Error('Choose a captured node and root before revealing a path.')
  })
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
  window.on('closed', () => {
    window = null
  })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}
app
  .whenReady()
  .then(async () => {
    if (!ownsProfile) return
    dbFile = await prepareHistory(app.getPath('userData'))
    store = new Store(openDb(dbFile))
    store.failInterruptedScans()
    if (hostOS === 'windows' && store.listDisks().some((disk) => disk.machineId === LEGACY_WINDOWS_MACHINE_ID))
      await ensureLocalMachine()
    registerIpc()
    createWindow()
  })
  .catch((error) => {
    console.error('Disk Watch startup failed:', error)
    app.exit(1)
  })
app.on('window-all-closed', () => app.quit())
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
