import { DatabaseSync } from 'node:sqlite'
import { canonicalPath, containsPath, deletePath, hidePath, pathKey } from '../shared/paths.ts'
import type {
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

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  )
  db.exec(SCHEMA)
  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (const [index, migration] of MIGRATIONS.entries()) {
    if (index < applied) continue
    db.exec('BEGIN')
    try {
      db.exec(migration)
      db.exec(`PRAGMA user_version = ${index + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  return db
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
  }
}

export interface DiskRow {
  id: number
  root: string
  rootNode: number
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

  listDisks(): DiskRow[] {
    return this.db
      .prepare(`SELECT id, root, root_node AS rootNode FROM disk ORDER BY root`)
      .all() as unknown as DiskRow[]
  }

  getDisk(diskId: number): DiskRow {
    const row = this.db.prepare(`SELECT id, root, root_node AS rootNode FROM disk WHERE id = ?`).get(diskId)
    if (!row) throw new Error(`No disk ${diskId}`)
    return row as unknown as DiskRow
  }

  addDisk(root: string): DiskRow {
    root = canonicalPath(root)
    const existing = this.db.prepare(`SELECT id FROM disk WHERE root = ?`).get(root) as { id: number } | undefined
    if (existing) return this.getDisk(existing.id)
    const node = this.db.prepare(`INSERT INTO node (parent, name, kind) VALUES (NULL, ?, 'dir')`).run(root)
    const disk = this.db
      .prepare(`INSERT INTO disk (root, root_node, created_at) VALUES (?, ?, ?)`)
      .run(root, node.lastInsertRowid, Date.now())
    return this.getDisk(Number(disk.lastInsertRowid))
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
    const { root } = this.getDisk(diskId)
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
      const insert = this.db.prepare(`INSERT OR IGNORE INTO exclude (disk_id, path) VALUES (?, ?)`)
      for (const path of normalized) insert.run(diskId, path)
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addExclude(diskId: number, path: string): void {
    const canonical = hidePath(this.getDisk(diskId).root, path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.excludes(diskId).some((existing) => pathKey(existing) === pathKey(canonical)))
        this.db.prepare('INSERT INTO exclude(disk_id,path) VALUES(?,?)').run(diskId, canonical)
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
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
    const paths = this.db.prepare('SELECT path FROM view_hide WHERE disk_id = ? ORDER BY path_key').all(diskId) as {
      path: string
    }[]
    const metadataEligible =
      /^[a-z]:\\$/i.test(disk.root) &&
      !!this.db
        .prepare("SELECT 1 FROM scan WHERE disk_id = ? AND status = 'complete' AND method = 'mft' LIMIT 1")
        .get(diskId)
    return {
      paths: paths.map((row) => row.path),
      metadata: !!flags.metadata,
      metadataEligible,
      revision: flags.revision,
    }
  }

  changeHides(diskId: number, change: HideChange): { settings: HideSettings; undo: HideUndo } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const before = this.hideSettings(diskId)
      const { root } = this.getDisk(diskId)
      if (change.type === 'metadata') {
        this.db.prepare('UPDATE disk SET hide_metadata = ? WHERE id = ?').run(Number(change.enabled), diskId)
      } else {
        const path = hidePath(root, change.path)
        const replacement = change.type === 'replace' ? hidePath(root, change.replacement) : path
        if (change.type !== 'add')
          this.db.prepare('DELETE FROM view_hide WHERE disk_id = ? AND path_key = ?').run(diskId, pathKey(path))
        if (change.type !== 'remove')
          this.db
            .prepare('INSERT OR IGNORE INTO view_hide (disk_id, path_key, path) VALUES (?, ?, ?)')
            .run(diskId, pathKey(replacement), replacement)
      }
      this.db.prepare('UPDATE disk SET hide_revision = hide_revision + 1 WHERE id = ?').run(diskId)
      const settings = this.hideSettings(diskId)
      this.db.exec('COMMIT')
      return {
        settings,
        undo: { diskId, expectedRevision: settings.revision, paths: before.paths, metadata: before.metadata },
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
      const { root } = this.getDisk(undo.diskId)
      const paths = undo.paths.map((path) => hidePath(root, path))
      this.db.prepare('DELETE FROM view_hide WHERE disk_id = ?').run(undo.diskId)
      const insert = this.db.prepare('INSERT OR IGNORE INTO view_hide (disk_id, path_key, path) VALUES (?, ?, ?)')
      for (const path of paths) insert.run(undo.diskId, pathKey(path), path)
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
    const path = deletePath(disk.root, this.nodePath(nodeId))
    const latest = this.latestCompleteScan(diskId)
    if (!latest) throw new Error('Scan this disk before staging deletion.')
    const entry = this.db
      .prepare(
        `SELECT n.kind, e.size, e.files FROM node n JOIN entry e ON e.node_id = n.id WHERE n.id = ? AND e.scan_id = ?`,
      )
      .get(nodeId, latest.id) as { kind: NodeKind; size: number; files: number } | undefined
    if (!entry || entry.kind === 'rest')
      throw new Error('This item is not in the latest scan. Scan again before staging it.')
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

  beginScan(diskId: number, excludes: string[]): number {
    const result = this.db
      .prepare(`INSERT INTO scan (disk_id, started_at, status, excludes) VALUES (?, ?, 'running', ?)`)
      .run(diskId, Date.now(), JSON.stringify(excludes))
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
    })
    return { grownFolders: grown.map(withPath), newFolders: added.map(withPath) }
  }

  nodePath(nodeId: number): string {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(id, parent, name, depth) AS (
           SELECT id, parent, name, 0 FROM node WHERE id = ?
           UNION ALL SELECT n.id, n.parent, n.name, up.depth + 1 FROM node n JOIN up ON n.id = up.parent
         ) SELECT name FROM up ORDER BY depth DESC`,
      )
      .all(nodeId) as { name: string }[]
    const [root, ...rest] = rows.map((row) => row.name)
    if (root === undefined) throw new Error(`No node ${nodeId}`)
    return rest.reduce((path, name) => (path.endsWith('\\') ? path + name : `${path}\\${name}`), root)
  }
}
