import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'
import { prepareHistory, HISTORY_BASENAME } from './history'
import { openDb, Store, SCHEMA_VERSION } from './store'

function legacyDb(file: string, version: number): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE node(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES node(id),name TEXT NOT NULL COLLATE NOCASE,kind TEXT NOT NULL,UNIQUE(parent,kind,name));
    CREATE TABLE disk(id INTEGER PRIMARY KEY,root TEXT NOT NULL UNIQUE COLLATE NOCASE,root_node INTEGER NOT NULL REFERENCES node(id),created_at INTEGER NOT NULL);
    CREATE TABLE exclude(disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,path TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(disk_id,path));
    CREATE TABLE scan(id INTEGER PRIMARY KEY,disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,size INTEGER NOT NULL DEFAULT 0,files INTEGER NOT NULL DEFAULT 0,dirs INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER,excludes TEXT NOT NULL,message TEXT,method TEXT,fallback TEXT);
    CREATE TABLE entry(scan_id INTEGER NOT NULL,node_id INTEGER NOT NULL,size INTEGER NOT NULL,files INTEGER NOT NULL,PRIMARY KEY(scan_id,node_id)) WITHOUT ROWID;
    CREATE TABLE scan_error(scan_id INTEGER NOT NULL REFERENCES scan(id) ON DELETE CASCADE,path TEXT NOT NULL,message TEXT NOT NULL);
    INSERT INTO node VALUES(7,NULL,'D:\\Legacy','dir');
    INSERT INTO disk VALUES(9,'D:\\Legacy',7,1);
    INSERT INTO scan(id,disk_id,started_at,status,size,files,excludes) VALUES(11,9,1,'complete',17,2,'[]');
    INSERT INTO entry VALUES(11,7,17,2);
  `)
  if (version === 0) db.exec('ALTER TABLE scan DROP COLUMN method; ALTER TABLE scan DROP COLUMN fallback;')
  if (version >= 2)
    db.exec(`ALTER TABLE disk ADD COLUMN hide_metadata INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE disk ADD COLUMN hide_revision INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE view_hide(disk_id INTEGER NOT NULL REFERENCES disk(id) ON DELETE CASCADE,path_key TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(disk_id,path_key));`)
  if (version >= 3)
    db.exec('ALTER TABLE entry ADD COLUMN created_at INTEGER; ALTER TABLE entry ADD COLUMN last_written_at INTEGER;')
  db.exec(`PRAGMA user_version=${version}`)
  return db
}

function directory() {
  return mkdtempSync(join(tmpdir(), 'dw-history-'))
}

test('legacy import uses a consistent read-only SQLite backup including committed WAL rows', async () => {
  const dir = directory()
  const legacy = join(dir, 'disk-watch.db')
  const source = legacyDb(legacy, 3)
  try {
    source.exec(
      "INSERT INTO node VALUES(8,7,'Folder','dir'); INSERT INTO entry VALUES(11,8,17,2,NULL,NULL); UPDATE disk SET hide_revision=4,hide_metadata=0;",
    )
    source.prepare('INSERT INTO view_hide VALUES(?,?,?)').run(9, 'd:\\legacy\\missing', 'D:\\Legacy\\Missing')
    const main = readFileSync(legacy)
    const wal = readFileSync(legacy + '-wal')
    const file = await prepareHistory(dir)
    expect(file).toBe(join(dir, HISTORY_BASENAME))
    expect(readFileSync(legacy)).toEqual(main)
    expect(readFileSync(legacy + '-wal')).toEqual(wal)
    const migrated = new Store(openDb(file))
    expect(migrated.getDisk(9)).toMatchObject({ rootNode: 7, targetOS: 'windows', machine: { kind: 'historical' } })
    expect(migrated.children(11, 7)[0]).toMatchObject({
      nodeId: 8,
      name: 'Folder',
      size: 17,
      createdAt: null,
      lastWrittenAt: null,
    })
    expect(migrated.hideSettings(9)).toMatchObject({ revision: 4, metadata: false, paths: ['D:\\Legacy\\Missing'] })
    migrated.db.close()
    expect(await prepareHistory(dir)).toBe(file)
    expect(
      readdirSync(dir).filter((name) => name.startsWith('.disk-watch-history-') && !name.endsWith('bootstrap.db')),
    ).toEqual([])
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration collisions fail on staging and preserve the original legacy database', async () => {
  const dir = directory()
  const legacy = join(dir, 'disk-watch.db')
  const source = legacyDb(legacy, 3)
  try {
    source.exec("INSERT INTO node VALUES(8,7,'Ä','dir'); INSERT INTO node VALUES(10,7,'ä','dir');")
    const main = readFileSync(legacy),
      wal = readFileSync(legacy + '-wal')
    await expect(prepareHistory(dir)).rejects.toThrow(/collision/)
    expect(existsSync(join(dir, HISTORY_BASENAME))).toBe(false)
    expect(readFileSync(legacy)).toEqual(main)
    expect(readFileSync(legacy + '-wal')).toEqual(wal)
    expect(
      readdirSync(dir).filter((name) => name.startsWith('.disk-watch-history-') && !name.endsWith('bootstrap.db')),
    ).toEqual([])
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid existing final files are never overwritten or replaced with legacy history', async () => {
  const dir = directory()
  const final = join(dir, HISTORY_BASENAME)
  try {
    writeFileSync(final, 'invalid history')
    const bytes = readFileSync(final)
    await expect(prepareHistory(dir)).rejects.toThrow()
    expect(readFileSync(final)).toEqual(bytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('newer schema versions are refused before openDb writes schema or journal settings', () => {
  const dir = directory(),
    file = join(dir, 'future.db')
  try {
    const future = new DatabaseSync(file)
    future.exec('CREATE TABLE future_payload(value TEXT); PRAGMA user_version=100;')
    future.close()
    const before = readFileSync(file)
    expect(() => openDb(file)).toThrow(/newer/)
    expect(readFileSync(file)).toEqual(before)
    expect(existsSync(file + '-wal')).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent initialization installs one valid database with no empty final file', async () => {
  const dir = directory()
  const source = legacyDb(join(dir, 'disk-watch.db'), 3)
  try {
    const results = await Promise.all([prepareHistory(dir), prepareHistory(dir)])
    expect(results[0]).toBe(results[1])
    const store = new Store(openDb(results[0]!))
    expect(store.listScans(9)[0]).toMatchObject({ id: 11, size: 17 })
    store.db.close()
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreign ownership violations prevent installation', async () => {
  const dir = directory()
  const source = legacyDb(join(dir, 'disk-watch.db'), 3)
  try {
    source.exec('INSERT INTO entry VALUES(11,999,1,1,NULL,NULL)')
    await expect(prepareHistory(dir)).rejects.toThrow(/without a saved scan or node/)
    expect(existsSync(join(dir, HISTORY_BASENAME))).toBe(false)
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('schema zero legacy imports retain IDs and initialize nullable metadata', async () => {
  const dir = directory(),
    source = legacyDb(join(dir, 'disk-watch.db'), 0)
  try {
    const file = await prepareHistory(dir),
      store = new Store(openDb(file))
    expect(store.getDisk(9).rootNode).toBe(7)
    expect(store.listScans(9)[0]).toMatchObject({ id: 11, method: null, fallback: null, size: 17 })
    expect(store.db.prepare('SELECT created_at,last_written_at FROM entry').get()).toEqual({
      created_at: null,
      last_written_at: null,
    })
    store.db.close()
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// This covers child startup and two durable imports on Windows storage.
test('a killed initializer leaves no final file and the next process can initialize', async () => {
  const dir = directory(),
    source = legacyDb(join(dir, 'disk-watch.db'), 3)
  try {
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      fs.linkSync=()=>{fs.writeFileSync(process.argv[1]+'/reached-install','ready');process.kill(process.pid,'SIGKILL')}; syncBuiltinESMExports();
      const {prepareHistory}=await import(${JSON.stringify(new URL('./history.ts', import.meta.url).href)});
      await prepareHistory(process.argv[1]);`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], {
      encoding: 'utf8',
      timeout: 10000,
    })
    expect(child.error).toBeUndefined()
    expect(readFileSync(join(dir, 'reached-install'), 'utf8')).toBe('ready')
    expect(child.status === null || child.status !== 0).toBe(true)
    expect(child.signal === 'SIGKILL' || child.status !== 0).toBe(true)
    expect(existsSync(join(dir, HISTORY_BASENAME))).toBe(false)
    const file = await prepareHistory(dir),
      store = new Store(openDb(file))
    expect(store.listScans(9)[0]).toMatchObject({ id: 11, size: 17 })
    store.db.close()
  } finally {
    source.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('known native version four upgrades transactionally without replacing history or its IDs', async () => {
  const dir = directory(),
    file = join(dir, HISTORY_BASENAME)
  try {
    const store = new Store(openDb(file)),
      disk = store.addDisk('C:\\')
    const scan = store.beginScan(disk.id, [])
    store.db.prepare("UPDATE scan SET status='complete',size=17,files=2 WHERE id=?").run(scan)
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,17,2)').run(scan, disk.rootNode)
    store.db.exec(
      'ALTER TABLE disk DROP COLUMN root_refresh_scan; ALTER TABLE entry DROP COLUMN subtree_errors; ALTER TABLE disk DROP COLUMN scan_included; PRAGMA user_version=4',
    )
    store.db.close()
    expect(await prepareHistory(dir)).toBe(file)
    const upgraded = new Store(openDb(file))
    expect(upgraded.getDisk(disk.id).rootNode).toBe(disk.rootNode)
    expect(upgraded.listScans(disk.id)[0]).toMatchObject({ id: scan, size: 17, files: 2 })
    expect(upgraded.db.prepare('SELECT root_refresh_scan FROM disk WHERE id=?').get(disk.id)).toEqual({
      root_refresh_scan: 0,
    })
    expect(upgraded.db.prepare('SELECT subtree_errors FROM entry WHERE scan_id=?').get(scan)).toEqual({
      subtree_errors: null,
    })
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    upgraded.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('known native version five opens through prepareHistory and gains unknown read error counts', async () => {
  const dir = directory(),
    file = join(dir, HISTORY_BASENAME)
  try {
    const store = new Store(openDb(file)),
      disk = store.addDisk('C:\\')
    const scan = store.beginScan(disk.id, [])
    store.db.prepare("UPDATE scan SET status='complete',size=17,files=2 WHERE id=?").run(scan)
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,17,2)').run(scan, disk.rootNode)
    store.db.exec(
      'ALTER TABLE entry DROP COLUMN subtree_errors; ALTER TABLE disk DROP COLUMN scan_included; PRAGMA user_version=5',
    )
    store.db.close()
    expect(await prepareHistory(dir)).toBe(file)
    const upgraded = new Store(openDb(file))
    expect(upgraded.listScans(disk.id)[0]).toMatchObject({ id: scan, size: 17, files: 2 })
    expect(upgraded.db.prepare('SELECT subtree_errors FROM entry WHERE scan_id=?').get(scan)).toEqual({
      subtree_errors: null,
    })
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    upgraded.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prepareHistory refuses future native versions without writing to them', async () => {
  const dir = directory(),
    file = join(dir, HISTORY_BASENAME)
  try {
    const db = openDb(file)
    db.exec('PRAGMA user_version=100; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;')
    db.close()
    const before = readFileSync(file)
    await expect(prepareHistory(dir)).rejects.toThrow(/unsupported schema/)
    expect(readFileSync(file)).toEqual(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
