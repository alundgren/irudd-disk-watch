import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DiskWatchApi, ScanEvent } from '../shared/types'

const invoke =
  (channel: Exclude<keyof DiskWatchApi, 'onScanEvent'>) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const api: DiskWatchApi = {
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
  children: invoke('children'),
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
