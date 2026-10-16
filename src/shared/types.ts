export type TargetOS = 'windows' | 'macos' | 'linux'

export interface Machine {
  id: string
  kind: 'local' | 'ssh' | 'historical'
  os: TargetOS
  name: string
  destination?: string
  workerId?: string
  account?: string
}

export interface WorkerInfo {
  id: string
  account: string
  os: TargetOS
  version: 1
  /** `linuxPathTrust` marks Linux workers with per-folder cleanup trust checks. */
  capabilities: { scan: boolean; delete: boolean; linuxPathTrust?: boolean }
}

export interface NativeIdentity {
  device: string
  inode: string
  mount?: string
}
export interface NativeRoot {
  path: string
  pathBytes: string
  identity: NativeIdentity
  filesystem: string
  capacity: { total: number; free: number } | null
  observedAt: number
  readOnly: boolean
}
export interface NativeVolume {
  id: string
  name: string
  path: string
  os: TargetOS
  pathBytes?: string
  filesystem: string | null
  kind: 'local' | 'network' | 'removable' | 'system'
  readOnly: boolean | null
  capacity: { total: number; free: number } | null
  recommended: boolean
  mount?: string
  device?: string
}
export interface VolumeDiscovery {
  observedAt: number
  volumes: NativeVolume[]
  truncated: boolean
  errors: number
}
export interface ScanIssues {
  total: number
  issues: { path: string; message: string }[]
}
export interface PathRule {
  path: string
  components?: string[]
}
export interface NodeLocation {
  diskId: number
  path: string
  components: string[]
}
export type DeleteOperationState = 'pending' | 'running' | 'completed' | 'interrupted' | 'unknown'
export interface DeleteOperation {
  operationId: string
  diskId: number
  payload: unknown
  state: DeleteOperationState
  receipt?: unknown
  createdAt: number
  updatedAt: number
}

export type NodeKind = 'dir' | 'file' | 'rest'

export type ScanStatus = 'running' | 'complete' | 'failed' | 'cancelled'

/** `incremental` reuses unchanged Mac folders; `mft` reads NTFS metadata; `walk` reads every folder. */
export type ScanMethod = 'mft' | 'walk' | 'incremental'

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
  /** Why an optimization used a full scan, or could not save its baseline. */
  fallback: string | null
  message?: string | null
  coverage?: 'complete' | 'partial'
  rootObservation?: NativeRoot | null
  policy?: string
  skipped?: { symlinks: number; special: number; mounts: number }
}

export interface Disk {
  machineId?: string
  machine?: Machine
  targetOS?: TargetOS
  nativeRoot?: NativeRoot | null
  cleanupEnabled?: boolean
  excludeRules?: PathRule[]
  id: number
  root: string
  rootNode: number
  excludes: string[]
  latestScan: ScanSummary | null
  capacity: { total: number; free: number } | null
  hides: HideSettings
}

export interface HideSettings {
  rules?: PathRule[]
  paths: string[]
  metadata: boolean
  metadataEligible: boolean
  revision: number
}

export type HideChange =
  | { type: 'add'; path: string; components?: string[] }
  | { type: 'remove'; path: string; components?: string[] }
  | { type: 'replace'; path: string; replacement: string; components?: string[]; replacementComponents?: string[] }
  | { type: 'metadata'; enabled: boolean }

export interface HideUndo {
  rules?: PathRule[]
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
  createdAt: number | null
  /** Latest captured write in this node or its scanned descendants. */
  lastWrittenAt: number | null
}

/** Matching rules for Space filters. `now` is the renderer clock the Age column uses. */
export interface SearchQuery {
  nameContains?: string
  olderThanDays?: number
  now: number
  revision?: number
}

export interface SearchRow extends TreeRow {
  path: string
  /** Path components below the tracked root. Deletion needs at least two. */
  depth: number
}

/** Top-most matches only, largest first. `total` counts every match before the cap. */
export interface SearchResult {
  rows: SearchRow[]
  total: number
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
  components?: string[]
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
  diskId?: number
  machineId?: string
  components?: string[]
  identity?: NativeIdentity
  rootIdentity?: NativeIdentity
  rootObservation?: NativeRoot
  scanId: number
  nodeId: number
  path: string
  kind: Exclude<NodeKind, 'rest'>
  size: number
  files: number
  /** Staged from a scan with unreadable items elsewhere under the root. */
  partialScan?: boolean
}

export interface LockProcess {
  pid: number
  processName: string | null
  programName: string | null
  executablePath: string | null
  serviceName: string | null
  source: 'restart_manager' | 'open_handle'
  note: string | null
}

export interface DeleteFailure {
  errorDomain?: string
  machineId?: string
  path: string
  message: string
  failedPath?: string
  errorCode?: number | null
  lockInfo?: {
    status: 'found' | 'none' | 'unavailable' | 'not_checked'
    processes: LockProcess[]
    note: string
  }
}

export interface DeleteResult {
  machineName?: string
  operationId?: string
  state?: DeleteOperationState
  deleted: string[]
  failed: DeleteFailure[]
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
  discoverVolumes(destination?: string): Promise<VolumeDiscovery & { machine: Machine }>
  addVolume(machineId: string, volume: NativeVolume): Promise<Disk>
  addFolder(machineId: string, path: string): Promise<Disk>
  scanIssues(scanId: number): Promise<ScanIssues>
  reinspectRoot(diskId: number): Promise<Disk>
  setCleanupEnabled(diskId: number, enabled: boolean): Promise<void>
  nodeLocation(nodeId: number): Promise<NodeLocation>
  addExcludeNode(diskId: number, nodeId: number): Promise<string>
  showNode(diskId: number, nodeId: number): Promise<void>
  deleteOperations(diskId: number): Promise<DeleteOperation[]>
  recoverDelete(operationId: string): Promise<DeleteResult>
  listDisks(): Promise<Disk[]>
  removeDisk(diskId: number): Promise<void>
  pickExclude(diskId: number, kind: 'file' | 'dir'): Promise<string | null>
  setExcludes(diskId: number, paths: string[]): Promise<void>
  addExclude(diskId: number, path: string): Promise<void>
  openDisk(diskId: number): Promise<DiskSnapshot>
  changeHides(diskId: number, change: HideChange): Promise<{ settings: HideSettings; undo: HideUndo }>
  undoHides(undo: HideUndo): Promise<HideSettings>
  totals(scanId: number, revision: number): Promise<ViewTotal>
  deleteScan(scanId: number): Promise<void>
  startScan(mode?: 'full' | 'incremental'): Promise<void>
  cancelScan(): Promise<void>
  currentScan(): Promise<ScanProgress | null>
  openFullDiskAccessSettings(): Promise<void>
  onScanEvent(listener: (event: ScanEvent) => void): () => void
  children(scanId: number, nodeId: number, revision?: number): Promise<TreeRow[]>
  search(scanId: number, query: SearchQuery): Promise<SearchResult>
  diffChildren(fromScan: number, toScan: number, nodeId: number, revision?: number): Promise<DiffRow[]>
  compare(fromScan: number, toScan: number, revision: number): Promise<Comparison>
  nodePath(nodeId: number): Promise<string>
  stageDelete(diskId: number, nodeId: number): Promise<StagedDelete>
  executeDelete(diskId: number, targets: StagedDelete[]): Promise<DeleteResult>
  copyText(text: string): Promise<void>
  showInExplorer(path: string): Promise<void>
  isElevated(): Promise<boolean>
  restartElevated(): Promise<void>
}
