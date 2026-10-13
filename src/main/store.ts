import { DatabaseSync } from 'node:sqlite'
import type { DiffRow, Hotspot, NodeKind, ScanChanges, ScanStatus, ScanSummary, TreeRow } from '../shared/types'

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

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  )
  db.exec(SCHEMA)
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
    this.db.exec('BEGIN')
    this.db.prepare(`DELETE FROM exclude WHERE disk_id = ?`).run(diskId)
    const insert = this.db.prepare(`INSERT OR IGNORE INTO exclude (disk_id, path) VALUES (?, ?)`)
    for (const path of paths) insert.run(diskId, path)
    this.db.exec('COMMIT')
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
    this.db.prepare(`DELETE FROM entry WHERE scan_id = ?`).run(scanId)
    this.db.prepare(`DELETE FROM scan WHERE id = ?`).run(scanId)
    this.db.exec('COMMIT')
  }

  children(scanId: number, nodeId: number): TreeRow[] {
    return this.db
      .prepare(
        `SELECT n.id AS nodeId, n.name, n.kind, e.size, e.files
         FROM node n JOIN entry e ON e.scan_id = ? AND e.node_id = n.id
         WHERE n.parent = ?
         ORDER BY e.size DESC`,
      )
      .all(scanId, nodeId) as unknown as TreeRow[]
  }

  diffChildren(fromScan: number, toScan: number, nodeId: number): DiffRow[] {
    const rows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.name, n.kind,
                a.size AS beforeSize, a.files AS beforeFiles,
                b.size AS afterSize, b.files AS afterFiles
         FROM node n
         LEFT JOIN entry a ON a.scan_id = ? AND a.node_id = n.id
         LEFT JOIN entry b ON b.scan_id = ? AND b.node_id = n.id
         WHERE n.parent = ? AND (a.node_id IS NOT NULL OR b.node_id IS NOT NULL)
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
    return rows.map((row) => ({
      nodeId: row.nodeId,
      name: row.name,
      kind: row.kind,
      before: row.beforeSize === null ? null : { size: row.beforeSize, files: row.beforeFiles ?? 0 },
      after: row.afterSize === null ? null : { size: row.afterSize, files: row.afterFiles ?? 0 },
    }))
  }

  /**
   * `grownFolders` ranks folders by growth of the files directly inside them, which
   * points at where new data lands instead of at every ancestor of it.
   * `newFolders` lists the biggest folders that appeared under a folder that already existed.
   */
  changes(fromScan: number, toScan: number, limit = 15): ScanChanges {
    const grown = this.db
      .prepare(
        `SELECT n.parent AS nodeId, sum(x.before) AS before, sum(x.after) AS after
         FROM (
           SELECT node_id, size AS before, 0 AS after FROM entry WHERE scan_id = ?
           UNION ALL
           SELECT node_id, 0, size FROM entry WHERE scan_id = ?
         ) x JOIN node n ON n.id = x.node_id
         WHERE n.kind != 'dir'
         GROUP BY n.parent
         HAVING sum(x.after) > sum(x.before)
         ORDER BY sum(x.after) - sum(x.before) DESC
         LIMIT ?`,
      )
      .all(fromScan, toScan, limit) as { nodeId: number; before: number; after: number }[]
    const added = this.db
      .prepare(
        `SELECT n.id AS nodeId, 0 AS before, b.size AS after
         FROM entry b
         JOIN node n ON n.id = b.node_id AND n.kind = 'dir'
         JOIN entry parentBefore ON parentBefore.scan_id = ? AND parentBefore.node_id = n.parent
         WHERE b.scan_id = ?
           AND NOT EXISTS (SELECT 1 FROM entry a WHERE a.scan_id = ? AND a.node_id = n.id)
         ORDER BY b.size DESC
         LIMIT ?`,
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
