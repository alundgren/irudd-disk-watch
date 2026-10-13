export type NodeKind = 'dir' | 'file' | 'rest'

export type ScanStatus = 'running' | 'complete' | 'failed' | 'cancelled'

/** `mft` reads the NTFS master file table; `walk` lists folders one by one. */
export type ScanMethod = 'mft' | 'walk'

export interface ScanSummary {
  id: number
  diskId: number
  startedAt: number
  finishedAt: number | null
  status: ScanStatus
  size: number
  files: number
  dirs: number
  errors: number
  durationMs: number | null
  method: ScanMethod | null
  /** Why a scan fell back to walking folders instead of reading the MFT. */
  fallback: string | null
}

export interface Disk {
  id: number
  root: string
  rootNode: number
  excludes: string[]
  latestScan: ScanSummary | null
  capacity: { total: number; free: number } | null
}

export interface TreeRow {
  nodeId: number
  name: string
  kind: NodeKind
  size: number
  files: number
}

export interface Measure {
  size: number
  files: number
}

/** `before` is null when the node is new, `after` is null when it is gone. */
export interface DiffRow {
  nodeId: number
  name: string
  kind: NodeKind
  before: Measure | null
  after: Measure | null
}

export interface Hotspot {
  nodeId: number
  path: string
  before: number
  after: number
}

export interface ScanChanges {
  grownFolders: Hotspot[]
  newFolders: Hotspot[]
}

/** One click scans every tracked disk in turn. `index` counts from 0. */
export type ScanProgress = { diskId: number; index: number; count: number } & (
  | { phase: 'starting' }
  | { phase: 'reading'; files: number; dirs: number; bytes: number }
  | { phase: 'saving'; rows: number }
)

export type ScanEvent =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'disk-finished'; diskId: number; status: Exclude<ScanStatus, 'running'>; message?: string }
  | { type: 'run-finished' }

export interface DiskWatchApi {
  listDisks(): Promise<Disk[]>
  pickAndAddDisk(): Promise<Disk | null>
  removeDisk(diskId: number): Promise<void>
  pickExclude(diskId: number): Promise<string | null>
  setExcludes(diskId: number, paths: string[]): Promise<void>
  listScans(diskId: number): Promise<ScanSummary[]>
  deleteScan(scanId: number): Promise<void>
  startScan(): Promise<void>
  cancelScan(): Promise<void>
  currentScan(): Promise<ScanProgress | null>
  onScanEvent(listener: (event: ScanEvent) => void): () => void
  children(scanId: number, nodeId: number): Promise<TreeRow[]>
  diffChildren(fromScan: number, toScan: number, nodeId: number): Promise<DiffRow[]>
  changes(fromScan: number, toScan: number): Promise<ScanChanges>
  nodePath(nodeId: number): Promise<string>
  showInExplorer(path: string): Promise<void>
  isElevated(): Promise<boolean>
  restartElevated(): Promise<void>
}
