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
  hides: HideSettings
}

export interface HideSettings {
  paths: string[]
  metadata: boolean
  metadataEligible: boolean
  revision: number
}

export type HideChange =
  | { type: 'add'; path: string }
  | { type: 'remove'; path: string }
  | { type: 'replace'; path: string; replacement: string }
  | { type: 'metadata'; enabled: boolean }

export interface HideUndo {
  diskId: number
  expectedRevision: number
  paths: string[]
  metadata: boolean
}

export interface ViewTotal {
  raw: Measure
  hidden: Measure
  visible: Measure
}

export interface Comparison extends ScanChanges {
  diskId: number
  fromId: number
  toId: number
  revision: number
  before: ViewTotal
  after: ViewTotal
  rows: DiffRow[]
}

export interface DiskSnapshot {
  disk: Disk
  scans: ScanSummary[]
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

export interface StagedDelete {
  scanId: number
  nodeId: number
  path: string
  kind: Exclude<NodeKind, 'rest'>
  size: number
  files: number
}

export interface DeleteResult {
  deleted: string[]
  failed: { path: string; message: string }[]
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
  addExclude(diskId: number, path: string): Promise<void>
  openDisk(diskId: number): Promise<DiskSnapshot>
  changeHides(diskId: number, change: HideChange): Promise<{ settings: HideSettings; undo: HideUndo }>
  undoHides(undo: HideUndo): Promise<HideSettings>
  totals(scanId: number, revision: number): Promise<ViewTotal>
  deleteScan(scanId: number): Promise<void>
  startScan(): Promise<void>
  cancelScan(): Promise<void>
  currentScan(): Promise<ScanProgress | null>
  onScanEvent(listener: (event: ScanEvent) => void): () => void
  children(scanId: number, nodeId: number, revision?: number): Promise<TreeRow[]>
  diffChildren(fromScan: number, toScan: number, nodeId: number, revision?: number): Promise<DiffRow[]>
  compare(fromScan: number, toScan: number, revision: number): Promise<Comparison>
  nodePath(nodeId: number): Promise<string>
  stageDelete(diskId: number, nodeId: number): Promise<StagedDelete>
  executeDelete(diskId: number, targets: StagedDelete[]): Promise<DeleteResult>
  showInExplorer(path: string): Promise<void>
  isElevated(): Promise<boolean>
  restartElevated(): Promise<void>
}
