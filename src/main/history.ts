import { backup, DatabaseSync } from 'node:sqlite'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { openDb, SCHEMA_VERSION } from './store.ts'

export const HISTORY_BASENAME = 'disk-watch-native.db'

function validate(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok')
    throw new Error('History integrity check failed.')
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('History contains invalid foreign keys.')
  const orphan = db
    .prepare(
      `SELECT 1 FROM entry e LEFT JOIN scan s ON s.id=e.scan_id LEFT JOIN node n ON n.id=e.node_id
    WHERE s.id IS NULL OR n.id IS NULL LIMIT 1`,
    )
    .get()
  if (orphan) throw new Error('History contains entries without a saved scan or node.')
  const wrongOwner = db
    .prepare(
      `WITH RECURSIVE owned(id,disk_id) AS (
    SELECT root_node,id FROM disk UNION ALL SELECT n.id,owned.disk_id FROM node n JOIN owned ON n.parent=owned.id
  ) SELECT 1 FROM entry e JOIN scan s ON s.id=e.scan_id LEFT JOIN owned o ON o.id=e.node_id
    WHERE o.disk_id IS NULL OR o.disk_id!=s.disk_id LIMIT 1`,
    )
    .get()
  if (wrongOwner) throw new Error('History contains entries owned by another tracked root.')
}

function validateFinal(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('PRAGMA user_version').get()!
    if (row.user_version !== SCHEMA_VERSION)
      throw new Error(`Existing native history has unsupported schema ${row.user_version}.`)
    validate(db)
    db.prepare('SELECT machine_id,root_key,native_root FROM disk LIMIT 1').get()
    db.prepare('SELECT id FROM machine LIMIT 1').get()
  } finally {
    db.close()
  }
}

function syncFile(file: string): void {
  const fd = openSync(file, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Installs a complete checked history. The legacy database is only opened read-only. */
export async function prepareHistory(directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const final = join(directory, HISTORY_BASENAME)
  if (existsSync(final)) {
    validateFinal(final)
    return final
  }
  const lock = new DatabaseSync(join(directory, '.disk-watch-history-bootstrap.db'))
  lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE;')
  let locked = false
  try {
    const deadline = Date.now() + 5000
    while (!locked) {
      try {
        lock.exec('BEGIN IMMEDIATE')
        locked = true
      } catch (error) {
        if (!String(error).includes('locked') || Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  } catch (error) {
    lock.close()
    throw error
  }
  let staging: string | undefined
  try {
    if (existsSync(final)) {
      validateFinal(final)
      return final
    }
    staging = mkdtempSync(join(directory, '.disk-watch-history-'))
    const candidate = join(staging, 'history.db')
    const legacy = join(directory, 'disk-watch.db')
    if (existsSync(legacy)) {
      const source = new DatabaseSync(legacy, { readOnly: true })
      try {
        const version = source.prepare('PRAGMA user_version').get()!.user_version
        if (typeof version !== 'number' || version > 3) throw new Error(`Unsupported legacy history schema ${version}.`)
        await backup(source, candidate)
      } finally {
        source.close()
      }
    }
    const migrated = openDb(candidate)
    try {
      validate(migrated)
      migrated.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;')
    } finally {
      migrated.close()
    }
    validateFinal(candidate)
    chmodSync(candidate, 0o600)
    syncFile(candidate)
    // A hard link installs the checked file atomically and refuses an existing destination.
    linkSync(candidate, final)
    if (process.platform !== 'win32') syncFile(directory)
    return final
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true })
    if (locked) lock.exec('ROLLBACK')
    lock.close()
  }
}
