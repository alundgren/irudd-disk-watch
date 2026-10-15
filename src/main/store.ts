import { DatabaseSync } from 'node:sqlite'
import {
  canonicalPath,
  containsPath,
  deletePath,
  hidePath,
  pathKey,
  unixComponent,
  componentKey,
  unixLabel,
} from '../shared/paths.ts'
import type {
  Machine,
  NativeRoot,
  NativeIdentity,
  PathRule,
  NodeLocation,
  DeleteOperation,
  DeleteOperationState,
  TargetOS,
  Comparison,
  StagedDelete,
  HideChange,
  HideSettings,
  HideUndo,
  Measure,
  ViewTotal,
  DiffRow,
  Hotspot,
  NodeKind,
  ScanChanges,
  ScanMethod,
  ScanStatus,
  ScanSummary,
  TreeRow,
} from '../shared/types'

// Paths are interned once in `node` and shared by every scan. A scan stores one
// `entry` per dir, per file of at least --min-file-size, and per dir's leftover
// small files (a `rest` node). Comparing scans is a join on node id.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS node (
  id INTEGER PRIMARY KEY,
  parent INTEGER REFERENCES node(id),
  name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('dir', 'file', 'rest')),
  UNIQUE (parent, kind, name)
);
CREATE TABLE IF NOT EXISTS disk (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE COLLATE NOCASE,
  root_node INTEGER NOT NULL REFERENCES node(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exclude (
  disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,
  path TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (disk_id, path)
);
CREATE TABLE IF NOT EXISTS scan (
  id INTEGER PRIMARY KEY,
  disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
  size INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  dirs INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  excludes TEXT NOT NULL,
  message TEXT
);
CREATE TABLE IF NOT EXISTS entry (
  scan_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  files INTEGER NOT NULL,
  PRIMARY KEY (scan_id, node_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scan_error (
  scan_id INTEGER NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  message TEXT NOT NULL
);
`

// Applied in order after SCHEMA. PRAGMA user_version counts how many have run.
const MIGRATIONS = [
  'ALTER TABLE scan ADD COLUMN method TEXT; ALTER TABLE scan ADD COLUMN fallback TEXT;',
  `ALTER TABLE disk ADD COLUMN hide_metadata INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE disk ADD COLUMN hide_revision INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE view_hide (
     disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,
     path_key TEXT NOT NULL,
     path TEXT NOT NULL,
     PRIMARY KEY (disk_id, path_key)
   );`,
  'ALTER TABLE entry ADD COLUMN created_at INTEGER; ALTER TABLE entry ADD COLUMN last_written_at INTEGER;',
]

const NTFS_METADATA: [string, NodeKind][] = [
  ['$MFT', 'file'],
  ['$MFTMirr', 'file'],
  ['$LogFile', 'file'],
  ['$Volume', 'file'],
  ['$AttrDef', 'file'],
  ['$Bitmap', 'file'],
  ['$Boot', 'file'],
  ['$BadClus', 'file'],
  ['$Secure', 'file'],
  ['$UpCase', 'file'],
  ['$Extend', 'dir'],
]

export const SCHEMA_VERSION = 4
export const LEGACY_WINDOWS_MACHINE_ID = 'legacy-windows'

function migrateNative(db: DatabaseSync): void {
  db.exec(`CREATE TABLE machine (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('local','ssh','historical')),
    os TEXT NOT NULL CHECK(os IN ('windows','macos','linux')), name TEXT NOT NULL,
    destination TEXT, worker_id TEXT, account TEXT
  );
  CREATE UNIQUE INDEX machine_worker ON machine(worker_id,account) WHERE worker_id IS NOT NULL AND account IS NOT NULL;
  INSERT INTO machine VALUES('legacy-windows','historical','windows','Windows history',NULL,NULL,NULL);
  CREATE TABLE node_new (
    id INTEGER PRIMARY KEY, parent INTEGER REFERENCES node(id), name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dir','file','rest')), name_bytes TEXT, identity_key TEXT,
    UNIQUE(parent,kind,identity_key)
  );
  CREATE TABLE disk_new (
    id INTEGER PRIMARY KEY, root TEXT NOT NULL, root_node INTEGER NOT NULL REFERENCES node(id),
    created_at INTEGER NOT NULL, hide_metadata INTEGER NOT NULL DEFAULT 1,
    hide_revision INTEGER NOT NULL DEFAULT 0, machine_id TEXT NOT NULL REFERENCES machine(id),
    root_key TEXT NOT NULL, native_root TEXT, cleanup_enabled INTEGER NOT NULL DEFAULT 0,
    UNIQUE(machine_id,root_key)
  );`)
  const insertNode = db.prepare('INSERT INTO node_new(id,parent,name,kind,identity_key) VALUES(?,?,?,?,?)')
  for (const row of db.prepare('SELECT id,parent,name,kind FROM node').iterate() as Iterable<{
    id: number
    parent: number | null
    name: string
    kind: string
  }>) {
    try {
      insertNode.run(row.id, row.parent, row.name, row.kind, 'w:' + row.name.toLowerCase())
    } catch {
      throw new Error(`Legacy Windows node comparison collision at node ${row.id}. Original history was not changed.`)
    }
  }
  const insertDisk = db.prepare(
    'INSERT INTO disk_new(id,root,root_node,created_at,hide_metadata,hide_revision,machine_id,root_key) VALUES(?,?,?,?,?,?,?,?)',
  )
  for (const row of db.prepare('SELECT * FROM disk').iterate() as Iterable<{
    id: number
    root: string
    root_node: number
    created_at: number
    hide_metadata: number
    hide_revision: number
  }>)
    insertDisk.run(
      row.id,
      row.root,
      row.root_node,
      row.created_at,
      row.hide_metadata,
      row.hide_revision,
      'legacy-windows',
      pathKey(row.root),
    )
  db.exec(`DROP TABLE disk; DROP TABLE node;
    ALTER TABLE node_new RENAME TO node; ALTER TABLE disk_new RENAME TO disk;
    CREATE TRIGGER legacy_node_key AFTER INSERT ON node WHEN NEW.identity_key IS NULL BEGIN
      UPDATE node SET identity_key = 'w:' || lower(NEW.name) WHERE id = NEW.id;
    END;
    ALTER TABLE exclude RENAME TO exclude_old;
    CREATE TABLE exclude (disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,
      path TEXT NOT NULL, path_key TEXT NOT NULL, components TEXT, PRIMARY KEY(disk_id,path_key));
    ALTER TABLE view_hide ADD COLUMN components TEXT;
    ALTER TABLE scan ADD COLUMN coverage TEXT NOT NULL DEFAULT 'complete' CHECK(coverage IN ('complete','partial'));
    ALTER TABLE scan ADD COLUMN root_observation TEXT;
    ALTER TABLE entry ADD COLUMN native_identity TEXT;
    CREATE TABLE delete_operation (
      operation_id TEXT PRIMARY KEY, disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','interrupted','unknown')),
      receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
  const insertExclude = db.prepare('INSERT INTO exclude(disk_id,path,path_key) VALUES(?,?,?)')
  for (const row of db.prepare('SELECT disk_id,path FROM exclude_old').all() as { disk_id: number; path: string }[])
    insertExclude.run(row.disk_id, row.path, pathKey(row.path))
  db.exec('DROP TABLE exclude_old')
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (applied > SCHEMA_VERSION)
      throw new Error(`History schema ${applied} is newer than supported schema ${SCHEMA_VERSION}.`)
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(SCHEMA)
      for (const [index, migration] of MIGRATIONS.entries()) {
        if (index < applied) continue
        db.exec(migration)
      }
      if (applied < 4) migrateNative(db)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('History contains invalid ownership references.')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

interface ScanRow {
  id: number
  disk_id: number
  started_at: number
  finished_at: number | null
  status: ScanStatus
  size: number
  files: number
  dirs: number
  errors: number
  duration_ms: number | null
  method: ScanMethod | null
  fallback: string | null
  coverage: 'complete' | 'partial'
  root_observation: string | null
}

function toScan(row: ScanRow): ScanSummary {
  return {
    id: row.id,
    diskId: row.disk_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    size: row.size,
    files: row.files,
    dirs: row.dirs,
    errors: row.errors,
    durationMs: row.duration_ms,
    method: row.method,
    fallback: row.fallback,
    coverage: row.coverage,
    rootObservation: row.root_observation ? JSON.parse(row.root_observation) : null,
  }
}

export interface DiskRow {
  id: number
  root: string
  rootNode: number
  machineId: string
  machine: Machine
  targetOS: TargetOS
  nativeRoot: NativeRoot | null
  cleanupEnabled: boolean
}

export class Store {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** Scans left `running` by a crashed or closed app never finished. */
  failInterruptedScans(): void {
    const stale = this.db.prepare(`SELECT id FROM scan WHERE status = 'running'`).all() as { id: number }[]
    for (const { id } of stale) {
      this.db.prepare(`DELETE FROM entry WHERE scan_id = ?`).run(id)
      this.db
        .prepare(`UPDATE scan SET status = 'failed', message = 'Interrupted before it finished' WHERE id = ?`)
        .run(id)
    }
  }

  upsertMachine(machine: Machine): Machine {
    if (
      !machine.id ||
      !machine.name ||
      !['windows', 'macos', 'linux'].includes(machine.os) ||
      !['local', 'ssh', 'historical'].includes(machine.kind)
    )
      throw new Error('Invalid execution machine.')
    const existing = this.db.prepare('SELECT id FROM machine WHERE id=?').get(machine.id)
    if (existing) {
      const old = this.getMachine(machine.id)
      if (
        old.os !== machine.os ||
        old.kind !== machine.kind ||
        old.workerId !== machine.workerId ||
        old.account !== machine.account
      )
        throw new Error('A saved machine cannot change execution identity.')
    }
    this.db
      .prepare(
        `INSERT INTO machine(id,kind,os,name,destination,worker_id,account) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,destination=excluded.destination`,
      )
      .run(
        machine.id,
        machine.kind,
        machine.os,
        machine.name,
        machine.destination ?? null,
        machine.workerId ?? null,
        machine.account ?? null,
      )
    return this.getMachine(machine.id)
  }

  bindLegacyWindowsMachine(worker: { id: string; account: string }): Machine {
    if (!worker.id || !worker.account) throw new Error('Inspect the Windows execution worker first.')
    const old = this.getMachine(LEGACY_WINDOWS_MACHINE_ID)
    if (old.workerId && (old.workerId !== worker.id || old.account !== worker.account))
      throw new Error('Windows history is already bound to another worker.')
    this.db
      .prepare("UPDATE machine SET kind='local',worker_id=?,account=? WHERE id=?")
      .run(worker.id, worker.account, LEGACY_WINDOWS_MACHINE_ID)
    return this.getMachine(LEGACY_WINDOWS_MACHINE_ID)
  }

  getMachine(id: string): Machine {
    const row = this.db.prepare('SELECT * FROM machine WHERE id=?').get(id)
    if (!row) throw new Error(`No machine ${id}`)
    return {
      id: String(row.id),
      kind: row.kind as Machine['kind'],
      os: row.os as TargetOS,
      name: String(row.name),
      ...(row.destination === null ? {} : { destination: String(row.destination) }),
      ...(row.worker_id === null ? {} : { workerId: String(row.worker_id) }),
      ...(row.account === null ? {} : { account: String(row.account) }),
    }
  }

  listMachines(): Machine[] {
    return (this.db.prepare('SELECT id FROM machine ORDER BY name,id').all() as { id: string }[]).map(({ id }) =>
      this.getMachine(id),
    )
  }

  listDisks(): DiskRow[] {
    return (this.db.prepare('SELECT id FROM disk ORDER BY root,id').all() as { id: number }[]).map(({ id }) =>
      this.getDisk(id),
    )
  }

  getDisk(diskId: number): DiskRow {
    const row = this.db.prepare('SELECT * FROM disk WHERE id=?').get(diskId)
    if (!row) throw new Error(`No disk ${diskId}`)
    const machine = this.getMachine(String(row.machine_id))
    return {
      id: Number(row.id),
      root: String(row.root),
      rootNode: Number(row.root_node),
      machineId: machine.id,
      machine,
      targetOS: machine.os,
      nativeRoot: row.native_root ? JSON.parse(String(row.native_root)) : null,
      cleanupEnabled: !!row.cleanup_enabled,
    }
  }

  addDisk(root: string, machineId = LEGACY_WINDOWS_MACHINE_ID): DiskRow {
    root = canonicalPath(root)
    if (machineId === LEGACY_WINDOWS_MACHINE_ID && !this.db.prepare('SELECT 1 FROM machine WHERE id=?').get(machineId))
      this.upsertMachine({ id: 'legacy-windows', kind: 'historical', os: 'windows', name: 'Windows history' })
    const machine = this.getMachine(machineId)
    if (machine.os !== 'windows') throw new Error('A Windows path needs a Windows execution machine.')
    return this.insertDisk(machineId, root, pathKey(root), null)
  }

  private insertDisk(machineId: string, root: string, key: string, observation: NativeRoot | null): DiskRow {
    const existing = this.db.prepare('SELECT id FROM disk WHERE machine_id=? AND root_key=?').get(machineId, key) as
      { id: number } | undefined
    if (existing) return this.getDisk(existing.id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const node = this.db
        .prepare("INSERT INTO node(parent,name,kind,identity_key) VALUES(NULL,?,'dir',?)")
        .run(root, observation ? 'u:root:' + key : 'w:' + root.toLowerCase())
      const disk = this.db
        .prepare('INSERT INTO disk(root,root_node,created_at,machine_id,root_key,native_root) VALUES(?,?,?,?,?,?)')
        .run(root, node.lastInsertRowid, Date.now(), machineId, key, observation ? JSON.stringify(observation) : null)
      this.db.exec('COMMIT')
      return this.getDisk(Number(disk.lastInsertRowid))
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addNativeDisk(machineId: string, root: NativeRoot): DiskRow {
    const machine = this.getMachine(machineId)
    if (machine.kind === 'historical' || !machine.workerId || !machine.account)
      throw new Error('Inspect the execution worker first.')
    validateRoot(root)
    if (machine.os === 'windows') throw new Error('Native roots require a Unix execution machine.')
    return this.insertDisk(machineId, root.path, root.pathBytes, root)
  }

  setCleanupEnabled(diskId: number, enabled: boolean): void {
    const disk = this.getDisk(diskId)
    if (!disk.nativeRoot || disk.machine.kind === 'historical' || (enabled && disk.nativeRoot.readOnly))
      throw new Error('This root is scan-only.')
    this.db.prepare('UPDATE disk SET cleanup_enabled=? WHERE id=?').run(Number(enabled), diskId)
  }

  internNode(parent: number, kind: NodeKind, name: string, nameBytes?: string): number {
    const disk = this.getDisk(this.nodeLocation(parent).diskId)
    if (!['dir', 'file', 'rest'].includes(kind)) throw new Error('Invalid node kind.')
    const encoded = kind === 'rest' ? null : disk.targetOS === 'windows' ? null : unixComponent(nameBytes ?? '')
    const key = encoded === null ? 'w:' + name.toLowerCase() : 'u:' + encoded
    if (encoded && name !== unixLabel(encoded)) throw new Error('Unix label does not match its encoded name.')
    const old = this.db
      .prepare('SELECT id FROM node WHERE parent=? AND kind=? AND identity_key=?')
      .get(parent, kind, key) as { id: number } | undefined
    if (old) return old.id
    return Number(
      this.db
        .prepare('INSERT INTO node(parent,name,kind,name_bytes,identity_key) VALUES(?,?,?,?,?)')
        .run(parent, name, kind, encoded, key).lastInsertRowid,
    )
  }

  removeDisk(diskId: number): void {
    const { rootNode } = this.getDisk(diskId)
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`DELETE FROM entry WHERE scan_id IN (SELECT id FROM scan WHERE disk_id = ?)`).run(diskId)
      this.db.prepare(`DELETE FROM disk WHERE id = ?`).run(diskId)
      this.db
        .prepare(
          `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT node.id FROM node JOIN sub ON node.parent = sub.id)
           DELETE FROM node WHERE id IN (SELECT id FROM sub)`,
        )
        .run(rootNode)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  excludes(diskId: number): string[] {
    const rows = this.db.prepare(`SELECT path FROM exclude WHERE disk_id = ? ORDER BY path`).all(diskId) as {
      path: string
    }[]
    return rows.map((row) => row.path)
  }

  setExcludes(diskId: number, paths: string[]): void {
    const { root, targetOS } = this.getDisk(diskId)
    if (targetOS !== 'windows') throw new Error('Resolve Unix rules through the native worker.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const normalized = [
        ...new Map(
          paths.map((path) => {
            const canonical = hidePath(root, path)
            return [pathKey(canonical), canonical] as const
          }),
        ).values(),
      ]
      this.db.prepare(`DELETE FROM exclude WHERE disk_id = ?`).run(diskId)
      const insert = this.db.prepare(`INSERT OR IGNORE INTO exclude (disk_id, path, path_key) VALUES (?, ?, ?)`)
      for (const path of normalized) insert.run(diskId, path, pathKey(path))
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addExclude(diskId: number, path: string): void {
    const disk = this.getDisk(diskId)
    if (disk.targetOS !== 'windows') throw new Error('Resolve Unix rules through the native worker.')
    const canonical = hidePath(disk.root, path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.excludes(diskId).some((existing) => pathKey(existing) === pathKey(canonical)))
        this.db
          .prepare('INSERT INTO exclude(disk_id,path,path_key) VALUES(?,?,?)')
          .run(diskId, canonical, pathKey(canonical))
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  excludeRules(diskId: number): PathRule[] {
    this.getDisk(diskId)
    return (
      this.db.prepare('SELECT path,components FROM exclude WHERE disk_id=? ORDER BY path_key').all(diskId) as {
        path: string
        components: string | null
      }[]
    ).map((row) => ({ path: row.path, ...(row.components ? { components: JSON.parse(row.components) } : {}) }))
  }

  private checkedRule(diskId: number, rule: PathRule): { path: string; key: string; components: string | null } {
    const disk = this.getDisk(diskId)
    if (disk.targetOS === 'windows') {
      const path = hidePath(disk.root, rule.path)
      return { path, key: pathKey(path), components: null }
    }
    if (!rule.components?.length || typeof rule.path !== 'string' || !rule.path)
      throw new Error('Resolve Unix rules through the native worker.')
    return { path: rule.path, key: 'u:' + componentKey(rule.components), components: componentKey(rule.components) }
  }

  setExcludeRules(diskId: number, rules: PathRule[]): void {
    const checked = rules.map((rule) => this.checkedRule(diskId, rule))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM exclude WHERE disk_id=?').run(diskId)
      const insert = this.db.prepare('INSERT OR IGNORE INTO exclude(disk_id,path,path_key,components) VALUES(?,?,?,?)')
      for (const rule of checked) insert.run(diskId, rule.path, rule.key, rule.components)
      this.db.prepare('UPDATE disk SET hide_revision=hide_revision+1 WHERE id=?').run(diskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addExcludeRule(diskId: number, rule: PathRule): void {
    const checked = this.checkedRule(diskId, rule)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO exclude(disk_id,path,path_key,components) VALUES(?,?,?,?)')
        .run(diskId, checked.path, checked.key, checked.components)
      this.db.prepare('UPDATE disk SET hide_revision=hide_revision+1 WHERE id=?').run(diskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  hideSettings(diskId: number): HideSettings {
    const disk = this.getDisk(diskId)
    const flags = this.db
      .prepare('SELECT hide_metadata AS metadata, hide_revision AS revision FROM disk WHERE id = ?')
      .get(diskId) as { metadata: number; revision: number }
    const paths = this.db
      .prepare('SELECT path,components FROM view_hide WHERE disk_id = ? ORDER BY path_key')
      .all(diskId) as {
      path: string
      components: string | null
    }[]
    const metadataEligible =
      /^[a-z]:\\$/i.test(disk.root) &&
      !!this.db
        .prepare("SELECT 1 FROM scan WHERE disk_id = ? AND status = 'complete' AND method = 'mft' LIMIT 1")
        .get(diskId)
    return {
      paths: paths.map((row) => row.path),
      ...(disk.targetOS === 'windows'
        ? {}
        : { rules: paths.map((row) => ({ path: row.path, components: JSON.parse(row.components!) })) }),
      metadata: !!flags.metadata,
      metadataEligible,
      revision: flags.revision,
    }
  }

  changeHides(diskId: number, change: HideChange): { settings: HideSettings; undo: HideUndo } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const before = this.hideSettings(diskId)
      if (change.type === 'metadata') {
        this.db.prepare('UPDATE disk SET hide_metadata = ? WHERE id = ?').run(Number(change.enabled), diskId)
      } else {
        const rule = this.checkedRule(diskId, { path: change.path, components: change.components })
        const replacement =
          change.type === 'replace'
            ? this.checkedRule(diskId, { path: change.replacement, components: change.replacementComponents })
            : rule
        if (change.type !== 'add')
          this.db.prepare('DELETE FROM view_hide WHERE disk_id=? AND path_key=?').run(diskId, rule.key)
        if (change.type !== 'remove')
          this.db
            .prepare('INSERT OR IGNORE INTO view_hide(disk_id,path_key,path,components) VALUES(?,?,?,?)')
            .run(diskId, replacement.key, replacement.path, replacement.components)
      }
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
      const settings = this.hideSettings(diskId)
      this.db.exec('COMMIT')
      return {
        settings,
        undo: {
          diskId,
          expectedRevision: settings.revision,
          paths: before.paths,
          metadata: before.metadata,
          ...(before.rules ? { rules: before.rules } : {}),
        },
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  undoHides(undo: HideUndo): HideSettings {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.hideSettings(undo.diskId)
      if (current.revision !== undo.expectedRevision)
        throw new Error('Hide settings changed since this action. Manage the current rules in Settings.')
      const rules = (undo.rules ?? undo.paths.map((path) => ({ path }))).map((rule) =>
        this.checkedRule(undo.diskId, rule),
      )
      this.db.prepare('DELETE FROM view_hide WHERE disk_id=?').run(undo.diskId)
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO view_hide(disk_id,path_key,path,components) VALUES(?,?,?,?)',
      )
      for (const rule of rules) insert.run(undo.diskId, rule.key, rule.path, rule.components)
      this.db
        .prepare('UPDATE disk SET hide_metadata = ?, hide_revision = hide_revision + 1 WHERE id = ?')
        .run(Number(undo.metadata), undo.diskId)
      const settings = this.hideSettings(undo.diskId)
      this.db.exec('COMMIT')
      return settings
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private scanDisk(scanId: number, nodeId?: number, revision?: number): DiskRow {
    const scan = this.db.prepare('SELECT disk_id FROM scan WHERE id = ?').get(scanId) as { disk_id: number } | undefined
    if (!scan) throw new Error(`No scan ${scanId}`)
    const disk = this.getDisk(scan.disk_id)
    if (revision !== undefined && revision !== this.hideSettings(disk.id).revision)
      throw new Error('The hidden paths changed. Reload this view.')
    if (nodeId !== undefined) {
      const ancestors = this.ancestors(nodeId)
      if (ancestors.at(-1)?.id !== disk.rootNode) throw new Error('The node does not belong to this scan’s disk.')
    }
    return disk
  }

  private ancestors(nodeId: number): { id: number; parent: number | null }[] {
    return this.db
      .prepare(
        `WITH RECURSIVE up(id, parent) AS (
      SELECT id, parent FROM node WHERE id = ? UNION ALL
      SELECT n.id, n.parent FROM node n JOIN up ON n.id = up.parent
    ) SELECT id, parent FROM up`,
      )
      .all(nodeId) as { id: number; parent: number | null }[]
  }

  private resolvePathNodes(disk: DiskRow, paths: string[]): Set<number> {
    const roots = new Set<number>()
    const children = this.db.prepare("SELECT id, name, kind FROM node WHERE parent = ? AND kind != 'rest'")
    const childrenByParent = new Map<number, { id: number; name: string; kind: NodeKind }[]>()
    const readChildren = (parent: number) => {
      let rows = childrenByParent.get(parent)
      if (!rows) {
        rows = children.all(parent) as { id: number; name: string; kind: NodeKind }[]
        childrenByParent.set(parent, rows)
      }
      return rows
    }
    const prefix = disk.root.endsWith('\\') ? disk.root : `${disk.root}\\`
    for (const path of paths) {
      const components = path.slice(prefix.length).split('\\')
      let parents = [disk.rootNode]
      for (const [index, component] of components.entries()) {
        parents = parents.flatMap((parent) => {
          const rows = readChildren(parent)
          return rows
            .filter(
              (row) =>
                row.name.toLowerCase() === component.toLowerCase() &&
                (index === components.length - 1 || row.kind === 'dir'),
            )
            .map((row) => row.id)
        })
        if (!parents.length) break
      }
      for (const parent of parents) roots.add(parent)
    }
    return roots
  }

  /** Resolve only saved paths. Subtree membership stays in SQLite's recursive query. */
  private hiddenRoots(disk: DiskRow): number[] {
    const settings = this.hideSettings(disk.id)
    if (disk.targetOS !== 'windows') {
      const roots = new Set<number>()
      const rules = [...(settings.rules ?? []), ...this.excludeRules(disk.id)]
      const children = this.db.prepare("SELECT id,kind,name_bytes FROM node WHERE parent=? AND kind!='rest'")
      for (const rule of rules) {
        if (!rule.components) throw new Error('Unix rule has no encoded components.')
        let parents = [disk.rootNode]
        for (const [index, part] of rule.components.entries()) {
          parents = parents.flatMap((parent) =>
            (children.all(parent) as { id: number; kind: NodeKind; name_bytes: string | null }[])
              .filter((row) => row.name_bytes === part && (index === rule.components!.length - 1 || row.kind === 'dir'))
              .map((row) => row.id),
          )
        }
        for (const id of parents) roots.add(id)
      }
      return [...roots].filter(
        (id) =>
          !this.ancestors(id)
            .slice(1)
            .some((parent) => roots.has(parent.id)),
      )
    }
    const combined = [
      ...new Map([...settings.paths, ...this.excludes(disk.id)].map((path) => [pathKey(path), path] as const)).values(),
    ]
    const paths = combined.filter(
      (path) => !combined.some((other) => pathKey(other) !== pathKey(path) && containsPath(other, path)),
    )
    const roots = this.resolvePathNodes(disk, paths)
    if (settings.metadata && settings.metadataEligible) {
      const rows = this.db
        .prepare("SELECT id, name, kind FROM node WHERE parent = ? AND kind != 'rest'")
        .all(disk.rootNode) as { id: number; name: string; kind: NodeKind }[]
      for (const row of rows)
        if (NTFS_METADATA.some(([name, kind]) => row.kind === kind && name.toLowerCase() === row.name.toLowerCase()))
          roots.add(row.id)
    }
    // Defaults can overlap saved rules; subtract each captured subtree once.
    return [...roots].filter(
      (id) =>
        !this.ancestors(id)
          .slice(1)
          .some((parent) => roots.has(parent.id)),
    )
  }

  stageDelete(diskId: number, nodeId: number): StagedDelete {
    const disk = this.getDisk(diskId)
    if (this.ancestors(nodeId).at(-1)?.id !== disk.rootNode) throw new Error('The item belongs to another disk.')
    const location = this.nodeLocation(nodeId)
    if (disk.targetOS !== 'windows' && (!disk.cleanupEnabled || disk.machine.kind === 'historical'))
      throw new Error('Enable cleanup for this root before staging deletion.')
    if (disk.targetOS !== 'windows' && location.components.length < 2)
      throw new Error('Root and top-level items cannot be deleted here.')
    const path = disk.targetOS === 'windows' ? deletePath(disk.root, location.path) : location.path
    const latest = this.latestCompleteScan(diskId)
    if (!latest) throw new Error('Scan this disk before staging deletion.')
    const entry = this.db
      .prepare(
        `SELECT n.kind, e.size, e.files, e.native_identity FROM node n JOIN entry e ON e.node_id = n.id WHERE n.id = ? AND e.scan_id = ?`,
      )
      .get(nodeId, latest.id) as
      { kind: NodeKind; size: number; files: number; native_identity: string | null } | undefined
    if (!entry || entry.kind === 'rest')
      throw new Error('This item is not in the latest scan. Scan again before staging it.')
    if (disk.targetOS !== 'windows') {
      const root = this.scanRoot(latest.id)
      if (!entry.native_identity || !root)
        throw new Error('This scan has no native object identity. Scan again before staging deletion.')
      return {
        nodeId,
        scanId: latest.id,
        path,
        kind: entry.kind,
        size: entry.size,
        files: entry.files,
        diskId,
        machineId: disk.machineId,
        components: location.components,
        identity: JSON.parse(entry.native_identity),
        rootIdentity: root.identity,
        rootObservation: root,
      }
    }
    return { nodeId, scanId: latest.id, path, kind: entry.kind, size: entry.size, files: entry.files }
  }

  private hiddenCte(roots: number[]): string {
    return `WITH RECURSIVE hidden(id) AS (SELECT id FROM node WHERE id IN (${roots.length ? roots.join(',') : 'NULL'}) UNION ALL SELECT n.id FROM node n JOIN hidden h ON n.parent = h.id)`
  }

  private adjustments(scanId: number, roots: number[]): Map<number, Measure> {
    const result = new Map<number, Measure>()
    const entry = this.db.prepare('SELECT size, files FROM entry WHERE scan_id = ? AND node_id = ?')
    for (const id of roots) {
      const hidden = entry.get(scanId, id) as Measure | undefined
      if (!hidden) continue
      for (const parent of this.ancestors(id).slice(1)) {
        const sum = result.get(parent.id) ?? { size: 0, files: 0 }
        result.set(parent.id, { size: sum.size + hidden.size, files: sum.files + hidden.files })
      }
    }
    return result
  }

  totals(scanId: number, revision?: number): ViewTotal {
    const disk = this.scanDisk(scanId, undefined, revision)
    const raw = this.db.prepare('SELECT size, files FROM scan WHERE id = ?').get(scanId) as unknown as Measure
    const hidden = this.adjustments(scanId, this.hiddenRoots(disk)).get(disk.rootNode) ?? { size: 0, files: 0 }
    return { raw, hidden, visible: { size: raw.size - hidden.size, files: raw.files - hidden.files } }
  }

  compare(fromId: number, toId: number, revision?: number): Comparison {
    this.db.exec('BEGIN')
    try {
      this.assertComparable(fromId, toId)
      const disk = this.scanDisk(fromId, undefined, revision)
      if (this.scanDisk(toId).id !== disk.id) throw new Error('Choose scans from the same disk.')
      const comparison: Comparison = {
        diskId: disk.id,
        fromId,
        toId,
        revision: this.hideSettings(disk.id).revision,
        before: this.totals(fromId),
        after: this.totals(toId),
        rows: fromId === toId ? [] : this.diffChildren(fromId, toId, disk.rootNode),
        ...(fromId === toId ? { grownFolders: [], newFolders: [] } : this.changes(fromId, toId)),
      }
      this.db.exec('COMMIT')
      return comparison
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listScans(diskId: number): ScanSummary[] {
    const rows = this.db.prepare(`SELECT * FROM scan WHERE disk_id = ? ORDER BY started_at DESC`).all(diskId)
    return (rows as unknown as ScanRow[]).map(toScan)
  }

  latestCompleteScan(diskId: number): ScanSummary | null {
    const row = this.db
      .prepare(`SELECT * FROM scan WHERE disk_id = ? AND status = 'complete' ORDER BY started_at DESC LIMIT 1`)
      .get(diskId)
    return row ? toScan(row as unknown as ScanRow) : null
  }

  beginScan(diskId: number, excludes: string[], root?: NativeRoot): number {
    const disk = this.getDisk(diskId)
    if (root) {
      validateRoot(root)
      if (
        !disk.nativeRoot ||
        disk.nativeRoot.pathBytes !== root.pathBytes ||
        !sameIdentity(disk.nativeRoot.identity, root.identity)
      )
        throw new Error('The root changed since it was configured.')
    }
    if (disk.nativeRoot && !root) root = disk.nativeRoot
    const result = this.db
      .prepare(
        `INSERT INTO scan (disk_id, started_at, status, excludes,root_observation) VALUES (?, ?, 'running', ?,?)`,
      )
      .run(diskId, Date.now(), JSON.stringify(excludes), root ? JSON.stringify(root) : null)
    return Number(result.lastInsertRowid)
  }

  endScan(scanId: number, status: Exclude<ScanStatus, 'running' | 'complete'>, message: string): void {
    this.db.prepare(`DELETE FROM entry WHERE scan_id = ?`).run(scanId)
    this.db
      .prepare(`UPDATE scan SET status = ?, finished_at = ?, message = ? WHERE id = ?`)
      .run(status, Date.now(), message, scanId)
  }

  deleteScan(scanId: number): void {
    this.db.exec('BEGIN')
    try {
      const disk = this.scanDisk(scanId)
      const eligible = this.hideSettings(disk.id).metadataEligible
      this.db.prepare(`DELETE FROM entry WHERE scan_id = ?`).run(scanId)
      this.db.prepare(`DELETE FROM scan WHERE id = ?`).run(scanId)
      if (eligible !== this.hideSettings(disk.id).metadataEligible)
        this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(disk.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  children(scanId: number, nodeId: number, revision?: number): TreeRow[] {
    const disk = this.scanDisk(scanId, nodeId, revision)
    const roots = this.hiddenRoots(disk)
    if (this.ancestors(nodeId).some((node) => roots.includes(node.id))) return []
    const adjustments = this.adjustments(scanId, roots)
    const rows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.name, n.kind, e.size, e.files,
                e.created_at AS createdAt, e.last_written_at AS lastWrittenAt
         FROM node n JOIN entry e ON e.scan_id = ? AND e.node_id = n.id
         WHERE n.parent = ? AND n.id NOT IN (${roots.length ? roots.join(',') : '-1'})
         ORDER BY e.size DESC`,
      )
      .all(scanId, nodeId) as unknown as TreeRow[]
    return rows
      .map((row) => {
        const hidden = adjustments.get(row.nodeId)
        return hidden ? { ...row, size: row.size - hidden.size, files: row.files - hidden.files } : row
      })
      .sort((a, b) => b.size - a.size)
  }

  diffChildren(fromScan: number, toScan: number, nodeId: number, revision?: number): DiffRow[] {
    this.assertComparable(fromScan, toScan)
    const disk = this.scanDisk(fromScan, nodeId, revision)
    if (this.scanDisk(toScan, nodeId).id !== disk.id) throw new Error('Choose scans from the same disk.')
    const roots = this.hiddenRoots(disk)
    if (this.ancestors(nodeId).some((node) => roots.includes(node.id))) return []
    const beforeHidden = this.adjustments(fromScan, roots)
    const afterHidden = this.adjustments(toScan, roots)
    const rows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.name, n.kind,
                a.size AS beforeSize, a.files AS beforeFiles,
                b.size AS afterSize, b.files AS afterFiles
         FROM node n
         LEFT JOIN entry a ON a.scan_id = ? AND a.node_id = n.id
         LEFT JOIN entry b ON b.scan_id = ? AND b.node_id = n.id
         WHERE n.parent = ? AND n.id NOT IN (${roots.length ? roots.join(',') : '-1'}) AND (a.node_id IS NOT NULL OR b.node_id IS NOT NULL)
         ORDER BY abs(coalesce(b.size, 0) - coalesce(a.size, 0)) DESC, coalesce(b.size, a.size) DESC`,
      )
      .all(fromScan, toScan, nodeId) as {
      nodeId: number
      name: string
      kind: NodeKind
      beforeSize: number | null
      beforeFiles: number | null
      afterSize: number | null
      afterFiles: number | null
    }[]
    return rows
      .map((row) => ({
        nodeId: row.nodeId,
        name: row.name,
        kind: row.kind,
        before:
          row.beforeSize === null
            ? null
            : {
                size: row.beforeSize - (beforeHidden.get(row.nodeId)?.size ?? 0),
                files: (row.beforeFiles ?? 0) - (beforeHidden.get(row.nodeId)?.files ?? 0),
              },
        after:
          row.afterSize === null
            ? null
            : {
                size: row.afterSize - (afterHidden.get(row.nodeId)?.size ?? 0),
                files: (row.afterFiles ?? 0) - (afterHidden.get(row.nodeId)?.files ?? 0),
              },
      }))
      .sort(
        (a, b) =>
          Math.abs((b.after?.size ?? 0) - (b.before?.size ?? 0)) -
          Math.abs((a.after?.size ?? 0) - (a.before?.size ?? 0)),
      )
  }

  /**
   * `grownFolders` ranks folders by growth of the files directly inside them, which
   * points at where new data lands instead of at every ancestor of it.
   * `newFolders` lists the biggest folders that appeared under a folder that already existed.
   */
  changes(fromScan: number, toScan: number, limit = 15): ScanChanges {
    this.assertComparable(fromScan, toScan)
    const disk = this.scanDisk(fromScan)
    if (this.scanDisk(toScan).id !== disk.id) throw new Error('Choose scans from the same disk.')
    const roots = this.hiddenRoots(disk)
    const afterHidden = this.adjustments(toScan, roots)
    const subtraction = [...afterHidden].map(([id, value]) => `(${id},${value.size})`).join(',') || '(NULL,0)'
    const grown = this.db
      .prepare(
        `${this.hiddenCte(roots)} SELECT n.parent AS nodeId, sum(x.before) AS before, sum(x.after) AS after
         FROM (
           SELECT node_id, size AS before, 0 AS after FROM entry WHERE scan_id = ?
           UNION ALL
           SELECT node_id, 0, size FROM entry WHERE scan_id = ?
         ) x JOIN node n ON n.id = x.node_id
         WHERE n.kind != 'dir' AND n.id NOT IN (SELECT id FROM hidden)
         GROUP BY n.parent
         HAVING sum(x.after) > sum(x.before)
         ORDER BY sum(x.after) - sum(x.before) DESC
         LIMIT ?`,
      )
      .all(fromScan, toScan, limit) as { nodeId: number; before: number; after: number }[]
    const added = this.db
      .prepare(
        `${this.hiddenCte(roots)}, adjustment(node_id,size) AS (VALUES ${subtraction}) SELECT n.id AS nodeId, 0 AS before, b.size - coalesce(adjustment.size,0) AS after
         FROM entry b
         JOIN node n ON n.id = b.node_id AND n.kind = 'dir'
         LEFT JOIN adjustment ON adjustment.node_id = n.id
         JOIN entry parentBefore ON parentBefore.scan_id = ? AND parentBefore.node_id = n.parent
         WHERE b.scan_id = ? AND n.id NOT IN (SELECT id FROM hidden)
           AND NOT EXISTS (SELECT 1 FROM entry a WHERE a.scan_id = ? AND a.node_id = n.id)
         ORDER BY b.size - coalesce(adjustment.size,0) DESC LIMIT ?`,
      )
      .all(fromScan, toScan, fromScan, limit) as { nodeId: number; before: number; after: number }[]
    const withPath = (row: { nodeId: number; before: number; after: number }): Hotspot => ({
      ...row,
      path: this.nodePath(row.nodeId),
      ...(disk.targetOS === 'windows' ? {} : { components: this.nodeLocation(row.nodeId).components }),
    })
    return { grownFolders: grown.map(withPath), newFolders: added.map(withPath) }
  }

  private assertComparable(fromId: number, toId: number): void {
    for (const id of [fromId, toId]) {
      const row = this.db.prepare('SELECT status,coverage FROM scan WHERE id=?').get(id)
      if (!row) throw new Error(`No scan ${id}`)
      if (row.coverage === 'partial')
        throw new Error(
          'Partial scans cannot be compared in Changes because unreadable or skipped entries could appear as removed files.',
        )
    }
  }

  setScanRoot(scanId: number, root: NativeRoot): void {
    const disk = this.scanDisk(scanId)
    validateRoot(root)
    if (
      !disk.nativeRoot ||
      disk.nativeRoot.pathBytes !== root.pathBytes ||
      !sameIdentity(disk.nativeRoot.identity, root.identity)
    )
      throw new Error('The root changed since it was configured.')
    this.db.prepare('UPDATE scan SET root_observation=? WHERE id=?').run(JSON.stringify(root), scanId)
  }

  scanRoot(scanId: number): NativeRoot | null {
    this.scanDisk(scanId)
    const row = this.db.prepare('SELECT root_observation FROM scan WHERE id=?').get(scanId)!
    return row.root_observation ? JSON.parse(String(row.root_observation)) : null
  }

  setEntryIdentity(scanId: number, nodeId: number, identity: NativeIdentity): void {
    const disk = this.scanDisk(scanId, nodeId)
    if (disk.targetOS === 'windows') throw new Error('Windows scan entries do not require native object identities.')
    validateIdentity(identity)
    const result = this.db
      .prepare('UPDATE entry SET native_identity=? WHERE scan_id=? AND node_id=?')
      .run(JSON.stringify(identity), scanId, nodeId)
    if (!result.changes) throw new Error('No saved scan entry for this identity.')
  }

  recordDeleteOperation(operation: {
    operationId: string
    diskId: number
    payload: unknown
    state: DeleteOperationState
    receipt?: unknown
  }): DeleteOperation {
    this.getDisk(operation.diskId)
    if (!operation.operationId) throw new Error('A deletion operation needs an ID.')
    const payload = JSON.stringify(operation.payload)
    if (payload === undefined) throw new Error('A deletion operation needs an immutable payload.')
    const existing = this.db
      .prepare('SELECT payload,disk_id FROM delete_operation WHERE operation_id=?')
      .get(operation.operationId)
    if (existing) {
      if (existing.payload !== payload || existing.disk_id !== operation.diskId)
        throw new Error('Deletion operation ID has a different request.')
      return this.getDeleteOperation(operation.operationId)
    }
    const now = Date.now()
    if (this.db.isTransaction) throw new Error('Deletion must be recorded outside scan transactions.')
    this.db.exec('PRAGMA synchronous=FULL')
    try {
      this.db
        .prepare(
          'INSERT INTO delete_operation(operation_id,disk_id,payload,state,receipt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          operation.operationId,
          operation.diskId,
          payload,
          operation.state,
          operation.receipt === undefined ? null : JSON.stringify(operation.receipt),
          now,
          now,
        )
    } finally {
      this.db.exec('PRAGMA synchronous=NORMAL')
    }
    return this.getDeleteOperation(operation.operationId)
  }

  updateDeleteOperation(operationId: string, state: DeleteOperationState, receipt?: unknown): DeleteOperation {
    const old = this.getDeleteOperation(operationId)
    if (old.state === 'completed' && state !== 'completed') throw new Error('A completed operation cannot restart.')
    if (this.db.isTransaction) throw new Error('Deletion must be recorded outside scan transactions.')
    this.db.exec('PRAGMA synchronous=FULL')
    try {
      this.db
        .prepare('UPDATE delete_operation SET state=?,receipt=coalesce(?,receipt),updated_at=? WHERE operation_id=?')
        .run(state, receipt === undefined ? null : JSON.stringify(receipt), Date.now(), operationId)
    } finally {
      this.db.exec('PRAGMA synchronous=NORMAL')
    }
    return this.getDeleteOperation(operationId)
  }

  getDeleteOperation(operationId: string): DeleteOperation {
    const row = this.db.prepare('SELECT * FROM delete_operation WHERE operation_id=?').get(operationId)
    if (!row) throw new Error(`No deletion operation ${operationId}`)
    return {
      operationId: String(row.operation_id),
      diskId: Number(row.disk_id),
      payload: JSON.parse(String(row.payload)),
      state: row.state as DeleteOperationState,
      ...(row.receipt === null ? {} : { receipt: JSON.parse(String(row.receipt)) }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  listDeleteOperations(diskId?: number): DeleteOperation[] {
    if (diskId !== undefined) this.getDisk(diskId)
    const rows =
      diskId === undefined
        ? this.db.prepare('SELECT operation_id FROM delete_operation ORDER BY created_at').all()
        : this.db.prepare('SELECT operation_id FROM delete_operation WHERE disk_id=? ORDER BY created_at').all(diskId)
    return rows.map((row) => this.getDeleteOperation(String(row.operation_id)))
  }

  nodeLocation(nodeId: number): NodeLocation {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(id,parent,name,name_bytes,depth) AS (
      SELECT id,parent,name,name_bytes,0 FROM node WHERE id=? UNION ALL
      SELECT n.id,n.parent,n.name,n.name_bytes,up.depth+1 FROM node n JOIN up ON n.id=up.parent
    ) SELECT id,name,name_bytes FROM up ORDER BY depth DESC`,
      )
      .all(nodeId) as { id: number; name: string; name_bytes: string | null }[]
    if (!rows.length) throw new Error(`No node ${nodeId}`)
    const owner = this.db.prepare('SELECT id FROM disk WHERE root_node=?').get(rows[0]!.id) as
      { id: number } | undefined
    if (!owner) throw new Error('The node has no tracked root.')
    const disk = this.getDisk(owner.id)
    const parts = rows.slice(1)
    if (disk.targetOS === 'windows')
      return {
        diskId: disk.id,
        path: parts.reduce((path, row) => (path.endsWith('\\') ? path + row.name : path + '\\' + row.name), disk.root),
        components: [],
      }
    if (parts.some((row) => row.name_bytes === null)) throw new Error('Unix node has no exact native name.')
    return {
      diskId: disk.id,
      path: parts.reduce((path, row) => (path.endsWith('/') ? path + row.name : path + '/' + row.name), disk.root),
      components: parts.map((row) => unixComponent(row.name_bytes!)),
    }
  }

  nodePath(nodeId: number): string {
    return this.nodeLocation(nodeId).path
  }
}

function validateIdentity(identity: NativeIdentity): void {
  if (
    !identity ||
    !/^(0|[1-9][0-9]*)$/.test(identity.device) ||
    !/^(0|[1-9][0-9]*)$/.test(identity.inode) ||
    (identity.mount !== undefined && !/^(0|[1-9][0-9]*)$/.test(identity.mount))
  )
    throw new Error('Invalid native identity.')
}
function validateRoot(root: NativeRoot): void {
  validateIdentity(root.identity)
  const bytes = Buffer.from(root.pathBytes, 'base64')
  if (
    bytes.toString('base64') !== root.pathBytes ||
    bytes[0] !== 47 ||
    bytes.includes(0) ||
    !root.path ||
    !Number.isSafeInteger(root.observedAt) ||
    root.observedAt < 0 ||
    typeof root.readOnly !== 'boolean' ||
    !root.filesystem
  )
    throw new Error('Invalid native root observation.')
  if (
    root.capacity &&
    [root.capacity.total, root.capacity.free].some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error('Invalid capacity.')
}

function sameIdentity(a: NativeIdentity, b: NativeIdentity): boolean {
  return a.device === b.device && a.inode === b.inode && a.mount === b.mount
}
