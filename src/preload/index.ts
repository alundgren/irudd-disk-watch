import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DiskWatchApi, ScanEvent } from '../shared/types'
import type { UpdateState } from '../shared/updates'

const invoke =
  (channel: Exclude<keyof DiskWatchApi, 'onScanEvent'>) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const api: DiskWatchApi = {
  githubAccess: {
    getState: () => ipcRenderer.invoke('githubAccess:getState'),
    save: (token) => ipcRenderer.invoke('githubAccess:save', token),
    clear: () => ipcRenderer.invoke('githubAccess:clear'),
  },
  updates: {
    getState: () => ipcRenderer.invoke('updates:getState'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    installAndRestart: () => ipcRenderer.invoke('updates:installAndRestart'),
    onState(listener) {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => listener(state)
      ipcRenderer.on('update-state', handler)
      return () => ipcRenderer.off('update-state', handler)
    },
  },
  installSshScanner: invoke('installSshScanner'),
  discoverVolumes: invoke('discoverVolumes'),
  addVolume: invoke('addVolume'),
  addFolder: invoke('addFolder'),
  scanIssues: invoke('scanIssues'),
  listDisks: invoke('listDisks'),
  setCleanupEnabled: invoke('setCleanupEnabled'),
  reinspectRoot: invoke('reinspectRoot'),
  nodeLocation: invoke('nodeLocation'),
  addExcludeNode: invoke('addExcludeNode'),
  showNode: invoke('showNode'),
  deleteOperations: invoke('deleteOperations'),
  recoverDelete: invoke('recoverDelete'),
  removeDisk: invoke('removeDisk'),
  setScanIncluded: invoke('setScanIncluded'),
  pickExclude: invoke('pickExclude'),
  setExcludes: invoke('setExcludes'),
  addExclude: invoke('addExclude'),
  openDisk: invoke('openDisk'),
  changeHides: invoke('changeHides'),
  undoHides: invoke('undoHides'),
  totals: invoke('totals'),
  deleteScan: invoke('deleteScan'),
  startScan: invoke('startScan'),
  cancelScan: invoke('cancelScan'),
  currentScan: invoke('currentScan'),
  openFullDiskAccessSettings: invoke('openFullDiskAccessSettings'),
  children: invoke('children'),
  search: invoke('search'),
  diffChildren: invoke('diffChildren'),
  compare: invoke('compare'),
  nodePath: invoke('nodePath'),
  executeDelete: invoke('executeDelete'),
  stageDelete: invoke('stageDelete'),
  copyText: invoke('copyText'),
  showInExplorer: invoke('showInExplorer'),
  isElevated: invoke('isElevated'),
  restartElevated: invoke('restartElevated'),
  onScanEvent(listener) {
    const handler = (_e: IpcRendererEvent, event: ScanEvent) => listener(event)
    ipcRenderer.on('scan-event', handler)
    return () => ipcRenderer.off('scan-event', handler)
  },
}

contextBridge.exposeInMainWorld('diskWatch', api)
