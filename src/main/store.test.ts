import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { canDeletePath, canonicalPath, deletePath, hidePath, pathAncestors } from '../shared/paths'
import { openDb, Store, SCHEMA_VERSION } from './store'
import { DatabaseSync } from 'node:sqlite'

export function legacyDb(file: string, version: number): DatabaseSync {
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

function fixture() {
  const store = new Store(openDb(':memory:'))
  const disk = store.addDisk('C:\\')
  const node = (parent: number, name: string, kind = 'dir') =>
    Number(store.db.prepare('INSERT INTO node(parent,name,kind) VALUES(?,?,?)').run(parent, name, kind).lastInsertRowid)
  const footage = node(disk.rootNode, 'Footage')
  const cache = node(footage, 'Cache')
  const blob = node(cache, 'blob.bin', 'file')
  const movie = node(footage, 'movie.mov', 'file')
  const gone = node(disk.rootNode, 'Gone')
  const goneFile = node(gone, 'gone.bin', 'file')
  const empty = node(disk.rootNode, 'Empty')
  const fresh = node(disk.rootNode, 'Fresh')
  const freshFile = node(fresh, 'new.bin', 'file')
  const scan = (time: number, rows: [number, number, number][]) => {
    const id = store.beginScan(disk.id, [])
    const size = rows.find((row) => row[0] === disk.rootNode)![1]
    const files = rows.find((row) => row[0] === disk.rootNode)![2]
    store.db
      .prepare("UPDATE scan SET status='complete',method='walk',started_at=?,size=?,files=?,dirs=5 WHERE id=?")
      .run(time, size, files, id)
    for (const [nodeId, size, files] of rows)
      store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,?,?)').run(id, nodeId, size, files)
    return id
  }
  const before = scan(1, [
    [disk.rootNode, 160, 3],
    [footage, 130, 2],
    [cache, 100, 1],
    [blob, 100, 1],
    [movie, 30, 1],
    [gone, 30, 1],
    [goneFile, 30, 1],
    [empty, 0, 0],
  ])
  const after = scan(2, [
    [disk.rootNode, 280, 3],
    [footage, 230, 2],
    [cache, 200, 1],
    [blob, 200, 1],
    [movie, 30, 1],
    [empty, 0, 0],
    [fresh, 50, 1],
    [freshFile, 50, 1],
  ])
  return { store, disk, footage, cache, blob, movie, gone, empty, fresh, freshFile, before, after, node, scan }
}

test('version-two snapshot timestamps migrate as null and remain scan-owned after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-age-migration-'))
  const file = join(dir, 'test.db')
  try {
    const legacy = legacyDb(file, 2)
    const disk = { id: 9, rootNode: 7 }
    const folder = 8
    const scan = 11
    legacy.prepare("INSERT INTO node VALUES(8,7,'Folder','dir')").run()
    legacy.prepare('INSERT INTO entry VALUES(11,8,17,2)').run()
    legacy.close()
    const migrated = new Store(openDb(file))
    const old = migrated.children(scan, disk.rootNode)[0]!
    expect(old).toMatchObject({ size: 17, files: 2, createdAt: null, lastWrittenAt: null })
    const later = migrated.beginScan(disk.id, [])
    migrated.db.prepare("UPDATE scan SET status='complete',size=18,files=2 WHERE id=?").run(later)
    migrated.db
      .prepare('INSERT INTO entry(scan_id,node_id,size,files,created_at,last_written_at) VALUES(?,?,18,2,1000,2000)')
      .run(later, folder)
    migrated.db.close()
    const reopened = new Store(openDb(file))
    expect(reopened.children(scan, disk.rootNode)[0]).toEqual(old)
    expect(reopened.children(later, disk.rootNode)[0]).toMatchObject({ createdAt: 1000, lastWrittenAt: 2000 })
    reopened.changeHides(disk.id, { type: 'add', path: 'D:\\Legacy\\Folder\\Absent' })
    expect(reopened.children(later, disk.rootNode)[0]).toMatchObject({ createdAt: 1000, lastWrittenAt: 2000 })
    reopened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows rules compare components, Unicode case, separators and normalized dots', () => {
  expect(canonicalPath('c:/Footage/Cache/../Ärea//file.bin')).toBe('C:\\Footage\\Ärea\\file.bin')
  expect(hidePath('C:\\Ärea', 'c:/äREA/Sub')).toBe('C:\\äREA\\Sub')
  expect(pathAncestors('C:\\', 'C:\\Footage\\Cache\\blob.bin')).toEqual([
    'C:\\Footage\\Cache\\blob.bin',
    'C:\\Footage\\Cache',
    'C:\\Footage',
  ])
  expect(pathAncestors('C:\\', 'C:\\Folder')).toEqual(['C:\\Folder'])
  expect(pathAncestors('C:\\Folder', 'C:\\Folder\\Sub\\file')).toEqual(['C:\\Folder\\Sub\\file', 'C:\\Folder\\Sub'])
  expect(pathAncestors('\\\\server\\share\\', '\\\\server\\share\\Folder\\file')).toEqual([
    '\\\\server\\share\\Folder\\file',
    '\\\\server\\share\\Folder',
  ])
  for (const path of [
    'C:\\Ärea',
    'C:\\Ärea2\\x',
    'D:\\Ärea\\x',
    'C:relative',
    '\\\\?\\C:\\Ärea\\x',
    '\\\\.\\C:\\x',
    'C:\\Ärea\\bad:stream',
    'C:\\Ärea\\bad.',
  ])
    expect(() => hidePath('C:\\Ärea', path)).toThrow()
})

test('hides adjust trees, historical rows, totals and hotspot ranking while captured data remains literal', () => {
  const f = fixture()
  const original = f.store.listScans(f.disk.id)
  f.store.changeHides(f.disk.id, { type: 'add', path: 'c:/footage/cache/blob.bin' })
  expect(f.store.children(f.after, f.disk.rootNode).map((row) => [row.name, row.size, row.files])).toEqual([
    ['Fresh', 50, 1],
    ['Footage', 30, 1],
    ['Empty', 0, 0],
  ])
  expect(f.store.children(f.after, f.cache)).toEqual([])
  expect(f.store.children(f.after, f.footage).map((row) => [row.name, row.size])).toEqual([
    ['movie.mov', 30],
    ['Cache', 0],
  ])
  const comparison = f.store.compare(f.before, f.after)
  expect(comparison.before).toEqual({
    raw: { size: 160, files: 3 },
    hidden: { size: 100, files: 1 },
    visible: { size: 60, files: 2 },
  })
  expect(comparison.after).toEqual({
    raw: { size: 280, files: 3 },
    hidden: { size: 200, files: 1 },
    visible: { size: 80, files: 2 },
  })
  expect(comparison.grownFolders.map((row) => [row.path, row.before, row.after])).toEqual([['C:\\Fresh', 0, 50]])
  expect(f.store.changes(f.before, f.after, 1).grownFolders.map((row) => row.path)).toEqual(['C:\\Fresh'])
  expect(comparison.rows.find((row) => row.name === 'Footage')).toMatchObject({
    before: { size: 30, files: 1 },
    after: { size: 30, files: 1 },
  })
  f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\Gone' })
  expect(f.store.diffChildren(f.before, f.after, f.disk.rootNode).some((row) => row.name === 'Gone')).toBe(false)
  f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\Fresh\\new.bin' })
  expect(f.store.compare(f.before, f.after).newFolders.map((row) => [row.path, row.after])).toEqual([['C:\\Fresh', 0]])
  expect(f.store.listScans(f.disk.id)).toEqual(original)
  expect(f.store.excludes(f.disk.id)).toEqual([])
  f.store.db.close()
})

test('overlapping saved rules stay independent and Undo refuses subsequent mutations', () => {
  const f = fixture()
  f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\Footage\\Cache' })
  const add = f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\Footage' })
  expect(f.store.hideSettings(f.disk.id).paths).toEqual(['C:\\Footage', 'C:\\Footage\\Cache'])
  expect(f.store.totals(f.after).hidden).toEqual({ size: 230, files: 2 })
  f.store.undoHides(add.undo)
  expect(f.store.totals(f.after).hidden).toEqual({ size: 200, files: 1 })
  expect(() => f.store.undoHides(add.undo)).toThrow(/changed/)
  const edit = f.store.changeHides(f.disk.id, { type: 'replace', path: 'C:\\Footage\\Cache', replacement: 'C:\\Fresh' })
  expect(f.store.hideSettings(f.disk.id).paths).toEqual(['C:\\Fresh'])
  expect(() => f.store.changeHides(f.disk.id, { type: 'replace', path: 'C:\\Fresh', replacement: 'C:\\' })).toThrow()
  expect(f.store.hideSettings(f.disk.id).revision).toBe(edit.settings.revision)
  expect(() => f.store.children(f.after, f.disk.rootNode, 0)).toThrow(/changed/)
  const other = f.store.addDisk('D:\\')
  const otherScan = f.store.beginScan(other.id, [])
  expect(() => f.store.children(otherScan, f.footage)).toThrow(/belong/)
  expect(() => f.store.compare(f.before, otherScan)).toThrow(/same disk/)
  expect(f.store.hideSettings(other.id).paths).toEqual([])
  f.store.db.close()
})

test('metadata defaults require local-root MFT evidence and only match exact root files', () => {
  const f = fixture()
  const mft = f.node(f.disk.rootNode, '$MFT', 'file')
  const dollar = f.node(f.disk.rootNode, '$User', 'file')
  const svi = f.node(f.disk.rootNode, 'System Volume Information')
  const recycle = f.node(f.disk.rootNode, '$Recycle.Bin')
  const apps = f.node(f.disk.rootNode, 'WindowsApps')
  const nested = f.node(f.footage, '$MFT', 'file')
  const extend = f.node(f.disk.rootNode, '$Extend')
  const journal = f.node(extend, '$UsnJrnl', 'file')
  const userExtend = f.node(f.footage, '$Extend')
  const userFile = f.node(userExtend, 'mine', 'file')
  const id = f.scan(3, [
    [f.disk.rootNode, 63, 8],
    [mft, 10, 1],
    [dollar, 5, 1],
    [svi, 4, 1],
    [recycle, 3, 1],
    [apps, 2, 1],
    [f.footage, 19, 2],
    [nested, 12, 1],
    [extend, 20, 1],
    [journal, 20, 1],
    [userExtend, 7, 1],
    [userFile, 7, 1],
  ])
  expect(f.store.totals(id).visible.size).toBe(63)
  f.store.db.prepare("UPDATE scan SET method='mft' WHERE id=?").run(id)
  expect(f.store.totals(id).visible.size).toBe(33)
  expect(f.store.children(id, extend)).toEqual([])
  expect(f.store.children(id, f.footage).map((row) => row.name)).toEqual(['$MFT', '$Extend'])
  expect(f.store.children(id, f.disk.rootNode).map((row) => row.name)).toEqual([
    'Footage',
    '$User',
    'System Volume Information',
    '$Recycle.Bin',
    'WindowsApps',
  ])
  f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\$MFT' })
  expect(f.store.totals(id).hidden.size).toBe(30)
  f.store.changeHides(f.disk.id, { type: 'remove', path: 'C:\\$MFT' })
  f.store.changeHides(f.disk.id, { type: 'metadata', enabled: false })
  expect(f.store.totals(id).hidden.size).toBe(0)
  const folder = f.store.addDisk('D:\\Folder')
  const scan = f.store.beginScan(folder.id, [])
  f.store.db.prepare("UPDATE scan SET status='complete',method='mft' WHERE id=?").run(scan)
  expect(f.store.hideSettings(folder.id).metadataEligible).toBe(false)
  f.store.db.close()
})

test('version-one databases migrate transactionally and rules survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-migration-'))
  const file = join(dir, 'test.db')
  try {
    const fresh = legacyDb(file, 1)
    const existing = { id: 9, rootNode: 7 }
    const oldScan = 11
    fresh.prepare('INSERT INTO exclude VALUES(?,?)').run(existing.id, 'D:\\Legacy\\Skip')
    fresh.close()
    const store = new Store(openDb(file))
    expect(store.listScans(existing.id)[0]).toMatchObject({ id: oldScan, size: 17, files: 2 })
    expect(store.excludes(existing.id)).toEqual(['D:\\Legacy\\Skip'])
    expect(store.totals(oldScan)).toEqual({
      raw: { size: 17, files: 2 },
      hidden: { size: 0, files: 0 },
      visible: { size: 17, files: 2 },
    })
    const disk = store.addDisk('C:\\')
    store.changeHides(disk.id, { type: 'add', path: 'C:\\Historical\\Gone' })
    store.changeHides(disk.id, { type: 'metadata', enabled: false })
    store.db.close()
    const reopened = new Store(openDb(file))
    expect(reopened.hideSettings(disk.id)).toEqual({
      paths: ['C:\\Historical\\Gone'],
      metadata: false,
      metadataEligible: false,
      revision: 2,
    })
    expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    reopened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one path rule hides file-to-folder changes across captured scans', () => {
  const f = fixture()
  const oldFile = f.node(f.disk.rootNode, 'Switch', 'file')
  const newDir = f.node(f.disk.rootNode, 'Switch', 'dir')
  const child = f.node(newDir, 'child.bin', 'file')
  const before = f.scan(4, [
    [f.disk.rootNode, 10, 1],
    [oldFile, 10, 1],
  ])
  const after = f.scan(5, [
    [f.disk.rootNode, 20, 1],
    [newDir, 20, 1],
    [child, 20, 1],
  ])
  f.store.changeHides(f.disk.id, { type: 'add', path: 'c:/SWITCH' })
  expect(f.store.compare(before, after)).toMatchObject({
    rows: [],
    grownFolders: [],
    newFolders: [],
    before: { hidden: { size: 10, files: 1 }, visible: { size: 0, files: 0 } },
    after: { hidden: { size: 20, files: 1 }, visible: { size: 0, files: 0 } },
  })
  expect(f.store.children(before, f.disk.rootNode)).toEqual([])
  expect(f.store.children(after, newDir)).toEqual([])
  expect(f.store.compare(after, before)).toMatchObject({
    rows: [],
    grownFolders: [],
    newFolders: [],
    before: { hidden: { size: 20, files: 1 }, visible: { size: 0, files: 0 } },
    after: { hidden: { size: 10, files: 1 }, visible: { size: 0, files: 0 } },
  })
  f.store.changeHides(f.disk.id, { type: 'replace', path: 'C:\\Switch', replacement: 'C:\\Switch\\child.bin' })
  expect(f.store.totals(before)).toMatchObject({ hidden: { size: 0, files: 0 }, visible: { size: 10, files: 1 } })
  expect(f.store.totals(after)).toMatchObject({ hidden: { size: 20, files: 1 }, visible: { size: 0, files: 0 } })
  expect(f.store.children(after, newDir)).toEqual([])
  f.store.db.close()
})

test('setExcludes recalculates trees, totals, diff rows and hotspots immediately', () => {
  const f = fixture()
  f.store.setExcludes(f.disk.id, ['c:/footage/cache'])
  expect(f.store.excludes(f.disk.id)).toEqual(['C:\\footage\\cache'])
  expect(f.store.children(f.after, f.footage).map((row) => [row.name, row.size])).toEqual([['movie.mov', 30]])
  expect(f.store.totals(f.after)).toEqual({
    raw: { size: 280, files: 3 },
    hidden: { size: 200, files: 1 },
    visible: { size: 80, files: 2 },
  })
  const comparison = f.store.compare(f.before, f.after)
  expect(comparison.grownFolders.map((row) => [row.path, row.before, row.after])).toEqual([['C:\\Fresh', 0, 50]])
  expect(comparison.rows.find((row) => row.name === 'Footage')).toMatchObject({
    before: { size: 30, files: 1 },
    after: { size: 30, files: 1 },
  })
  f.store.setExcludes(f.disk.id, [])
  expect(f.store.totals(f.after).visible.size).toBe(280)
  f.store.db.close()
})

test('deletePath rejects root and top-level items while accepting deeper files and folders', () => {
  expect(canDeletePath('C:\\', 'C:\\')).toBe(false)
  expect(canDeletePath('C:\\', 'C:\\foo')).toBe(false)
  expect(canDeletePath('C:\\', 'C:\\foo.txt')).toBe(false)
  expect(canDeletePath('C:\\', 'C:\\foo\\bar.txt')).toBe(true)
  expect(canDeletePath('C:\\', 'C:\\foo\\baz')).toBe(true)
  expect(deletePath('C:\\', 'c:/foo/bar.txt')).toBe('C:\\foo\\bar.txt')
  expect(deletePath('C:\\', 'c:/foo/baz')).toBe('C:\\foo\\baz')
  expect(() => deletePath('C:\\', 'C:\\')).toThrow()
  expect(() => deletePath('C:\\', 'C:\\foo')).toThrow()
  expect(canDeletePath('D:\\Tracked', 'D:\\Tracked\\top')).toBe(false)
  expect(canDeletePath('D:\\Tracked', 'D:\\Tracked\\top\\nested')).toBe(true)
})

test('file exclusions recalculate historical trees, folder totals and hotspots without altering captured data', () => {
  const f = fixture()
  const scans = f.store.listScans(f.disk.id)
  const entries = f.store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()
  f.store.addExclude(f.disk.id, 'c:/FOOTAGE/cache/BLOB.bin')
  expect(f.store.children(f.before, f.cache)).toEqual([])
  expect(f.store.children(f.after, f.cache)).toEqual([])
  expect(f.store.diffChildren(f.before, f.after, f.cache)).toEqual([])
  expect(f.store.children(f.after, f.footage).map(({ name, size }) => [name, size])).toEqual([
    ['movie.mov', 30],
    ['Cache', 0],
  ])
  const comparison = f.store.compare(f.before, f.after)
  expect(comparison.before.visible).toEqual({ size: 60, files: 2 })
  expect(comparison.after.visible).toEqual({ size: 80, files: 2 })
  expect(comparison.grownFolders.map(({ path, after }) => [path, after])).toEqual([['C:\\Fresh', 50]])
  f.store.addExclude(f.disk.id, 'C:\\Footage\\Cache')
  expect(f.store.totals(f.after).hidden).toEqual({ size: 200, files: 1 })
  f.store.setExcludes(f.disk.id, [])
  expect(f.store.totals(f.after).visible).toEqual({ size: 280, files: 3 })
  expect(f.store.listScans(f.disk.id)).toEqual(scans)
  expect(f.store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()).toEqual(entries)
  f.store.db.close()
})

test('staging uses the latest raw subtree size even when hotspot own files or filters show less', () => {
  const f = fixture()
  const sub = f.node(f.cache, 'nested')
  const file = f.node(sub, 'big.bin', 'file')
  f.store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,300,1)').run(f.after, sub)
  f.store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,300,1)').run(f.after, file)
  for (const id of [f.cache, f.footage, f.disk.rootNode])
    f.store.db.prepare('UPDATE entry SET size=size+300,files=files+1 WHERE scan_id=? AND node_id=?').run(f.after, id)
  f.store.db.prepare('UPDATE scan SET size=580,files=4 WHERE id=?').run(f.after)
  expect(f.store.changes(f.before, f.after).grownFolders.find((row) => row.nodeId === f.cache)?.after).toBe(200)
  f.store.addExclude(f.disk.id, 'C:\\Footage\\Cache\\nested')
  expect(f.store.children(f.after, f.footage).find((row) => row.nodeId === f.cache)?.size).toBe(200)
  expect(f.store.stageDelete(f.disk.id, f.cache)).toEqual({
    nodeId: f.cache,
    scanId: f.after,
    path: 'C:\\Footage\\Cache',
    kind: 'dir',
    size: 500,
    files: 2,
  })
  expect(() => f.store.stageDelete(f.disk.id, f.footage)).toThrow(/top-level/)
  expect(() => f.store.stageDelete(f.disk.id, f.gone)).toThrow()
  f.store.db.close()
})

test('atomic Exclude additions retain both rules and invalidate in-flight view revisions', () => {
  const f = fixture()
  const captured = f.store.listScans(f.disk.id)
  const revision = f.store.hideSettings(f.disk.id).revision
  f.store.addExclude(f.disk.id, 'C:\\Footage\\Cache')
  f.store.addExclude(f.disk.id, 'C:\\Fresh')
  f.store.addExclude(f.disk.id, 'c:/FOOTAGE/cache')
  expect(f.store.excludes(f.disk.id)).toEqual(['C:\\Footage\\Cache', 'C:\\Fresh'])
  expect(f.store.totals(f.after).visible).toEqual({ size: 30, files: 1 })
  expect(() => f.store.children(f.after, f.disk.rootNode, revision)).toThrow(/changed/)
  expect(f.store.listScans(f.disk.id)).toEqual(captured)
  f.store.db.close()
})

const encoded = (name: string) => Buffer.from(name).toString('base64')
function nativeFixture() {
  const store = new Store(openDb(':memory:'))
  store.upsertMachine({
    id: 'test-linux',
    kind: 'ssh',
    os: 'linux',
    name: 'Test machine',
    workerId: 'test-worker',
    account: 'test-account',
  })
  const root = {
    path: '/fixture',
    pathBytes: encoded('/fixture'),
    identity: { device: '1', inode: '2' },
    filesystem: 'testfs',
    capacity: null,
    observedAt: 1,
    readOnly: false,
  }
  const disk = store.addNativeDisk('test-linux', root)
  return { store, disk, root }
}

test('machine-scoped roots and exact Unix bytes keep case, invalid UTF-8 and literal escapes distinct', () => {
  const { store, disk, root } = nativeFixture()
  store.upsertMachine({
    id: 'test-mac',
    kind: 'local',
    os: 'macos',
    name: 'Other test machine',
    workerId: 'other-worker',
    account: 'test-account',
  })
  expect(store.addNativeDisk('test-mac', root).id).not.toBe(disk.id)
  const names = [
    ['A', encoded('A')],
    ['a', encoded('a')],
    ['\\xff', '/w=='],
    ['\\\\xff', encoded('\\xff')],
  ]
  const ids = names.map(([name, bytes]) => store.internNode(disk.rootNode, 'dir', name!, bytes))
  expect(new Set(ids).size).toBe(4)
  expect(ids.map((id) => store.nodeLocation(id).components)).toEqual(names.map(([, bytes]) => [bytes]))
  expect(store.internNode(disk.rootNode, 'dir', 'A', encoded('A'))).toBe(ids[0])
  expect(() => store.internNode(disk.rootNode, 'dir', 'wrong', encoded('A'))).toThrow(/label/)
  expect(() => store.setExcludes(disk.id, ['/fixture/A'])).toThrow(/worker/)
  expect(() => store.changeHides(disk.id, { type: 'add', path: '/fixture/A' })).toThrow(/worker/)
  store.db.close()
})

test('Unix hides and excludes use components through Undo and historical queries', () => {
  const { store, disk } = nativeFixture()
  const upper = store.internNode(disk.rootNode, 'dir', 'A', encoded('A'))
  const lower = store.internNode(disk.rootNode, 'dir', 'a', encoded('a'))
  const scan = store.beginScan(disk.id, [])
  store.db.prepare("UPDATE scan SET status='complete',size=30,files=2 WHERE id=?").run(scan)
  for (const [id, size] of [
    [disk.rootNode, 30],
    [upper, 10],
    [lower, 20],
  ])
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,?,1)').run(scan!, id!, size!)
  const change = store.changeHides(disk.id, { type: 'add', path: '/fixture/A', components: [encoded('A')] })
  expect(store.children(scan, disk.rootNode).map((row) => row.name)).toEqual(['a'])
  expect(store.totals(scan).hidden.size).toBe(10)
  store.undoHides(change.undo)
  expect(store.children(scan, disk.rootNode)).toHaveLength(2)
  store.addExcludeRule(disk.id, { path: 'display only', components: [encoded('a')] })
  expect(store.children(scan, disk.rootNode).map((row) => row.name)).toEqual(['A'])
  expect(store.excludeRules(disk.id)).toEqual([{ path: 'display only', components: [encoded('a')] }])
  store.db.close()
})

test('native deletion requires cleanup and identities from the selected saved scan', () => {
  const { store, disk, root } = nativeFixture()
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', encoded('nested'))
  const file = store.internNode(parent, 'file', 'file', encoded('file'))
  const scan = store.beginScan(disk.id, [])
  store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(scan)
  store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,10,1)').run(scan, file)
  expect(() => store.stageDelete(disk.id, file)).toThrow(/cleanup/)
  store.setCleanupEnabled(disk.id, true)
  expect(() => store.stageDelete(disk.id, file)).toThrow(/identity/)
  store.setEntryIdentity(scan, file, { device: '1', inode: '3' })
  expect(store.stageDelete(disk.id, file)).toMatchObject({
    machineId: disk.machineId,
    components: [encoded('nested'), encoded('file')],
    identity: { device: '1', inode: '3' },
    rootIdentity: root.identity,
  })
  expect(() => store.stageDelete(disk.id, parent)).toThrow(/top-level/)
  expect(() => store.setScanRoot(scan, { ...root, identity: { device: '1', inode: '99' } })).toThrow(/changed/)
  store.db.prepare("UPDATE scan SET coverage='partial' WHERE id=?").run(scan)
  expect(() => store.compare(scan, scan)).toThrow(/Partial scans/)
  expect(() => store.diffChildren(scan, scan, disk.rootNode)).toThrow(/Partial scans/)
  expect(() => store.changes(scan, scan)).toThrow(/Partial scans/)
  store.db.close()
})

test('deletion records never replay an ID with a different immutable request', () => {
  const { store, disk } = nativeFixture()
  const operation = {
    operationId: 'test-operation',
    diskId: disk.id,
    payload: { targets: ['test'] },
    state: 'pending' as const,
  }
  const first = store.recordDeleteOperation(operation)
  store.updateDeleteOperation(operation.operationId, 'interrupted', { state: 'interrupted' })
  expect(store.recordDeleteOperation(operation).state).toBe('interrupted')
  expect(() => store.recordDeleteOperation({ ...operation, payload: { targets: ['different'] } })).toThrow(
    /different request/,
  )
  expect(store.listDeleteOperations(disk.id)).toHaveLength(1)
  expect(store.getDeleteOperation(first.operationId).payload).toEqual(operation.payload)
  store.db.close()
})

test('legacy Windows inserts and internNode agree on Unicode case before and after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-unicode-keys-')),
    file = join(dir, 'history.db')
  try {
    const store = new Store(openDb(file)),
      disk = store.addDisk('C:\\')
    const id = Number(
      store.db.prepare("INSERT INTO node(parent,name,kind) VALUES(?,'Ä','dir')").run(disk.rootNode).lastInsertRowid,
    )
    expect(store.internNode(disk.rootNode, 'dir', 'ä')).toBe(id)
    expect(store.db.prepare('SELECT identity_key FROM node WHERE id=?').get(id)).toEqual({ identity_key: 'w:ä' })
    store.db.close()
    const reopened = new Store(openDb(file))
    const second = Number(
      reopened.db.prepare("INSERT INTO node(parent,name,kind) VALUES(?,'É','dir')").run(disk.rootNode).lastInsertRowid,
    )
    expect(reopened.internNode(disk.rootNode, 'dir', 'é')).toBe(second)
    expect(reopened.internNode(disk.rootNode, 'dir', 'ä')).toBe(id)
    reopened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('intentional native policy skips retain complete comparable coverage and persisted counters', () => {
  const { store, disk } = nativeFixture()
  const first = store.beginScan(disk.id, []),
    second = store.beginScan(disk.id, [])
  const policy = 'regular-files-single-mount-no-symlink-traversal'
  const skipped = { symlinks: 2, special: 3, mounts: 1 }
  for (const id of [first, second]) {
    store.db
      .prepare("UPDATE scan SET status='complete',coverage='complete',policy=?,skipped=? WHERE id=?")
      .run(policy, JSON.stringify(skipped), id)
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,0,0)').run(id, disk.rootNode)
  }
  expect(store.listScans(disk.id)[0]).toMatchObject({ coverage: 'complete', policy, skipped })
  expect(store.compare(first, second).rows).toEqual([])
  store.db.prepare("UPDATE scan SET coverage='partial' WHERE id=?").run(second)
  expect(() => store.compare(first, second)).toThrow(/Partial scans/)
  store.db.close()
})

test('saved issue details retain real totals and failure messages with a bounded sample', () => {
  const { store, disk } = nativeFixture()
  const scan = store.beginScan(disk.id, [])
  const insert = store.db.prepare('INSERT INTO scan_error(scan_id,path,message) VALUES(?,?,?)')
  for (let i = 0; i < 510; i++) insert.run(scan, `/fixture/${i}`, 'Permission denied')
  store.db.prepare("UPDATE scan SET errors=900,coverage='partial' WHERE id=?").run(scan)
  store.endScan(scan, 'failed', 'Fixture interrupted')
  expect(store.scanIssues(scan)).toMatchObject({ total: 900 })
  expect(store.scanIssues(scan).issues).toHaveLength(500)
  expect(store.listScans(disk.id)[0]?.message).toBe('Fixture interrupted')
  expect(() => store.scanIssues(scan + 1)).toThrow(/no longer/)
  store.db.close()
})

function nativeScan(store: Store, diskId: number, rootNode: number, file: number, time: number) {
  const id = store.beginScan(diskId, [])
  store.db.prepare("UPDATE scan SET status='complete',started_at=?,size=10,files=1 WHERE id=?").run(time, id)
  const parent = Number(store.db.prepare('SELECT parent FROM node WHERE id=?').get(file)!.parent)
  for (const node of new Set([rootNode, parent, file]))
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,10,1)').run(id, node)
  store.setEntryIdentity(id, file, { device: '1', inode: '3' })
  return id
}

test('native root reinspection preserves history rules and receipts while requiring a new scan for cleanup', () => {
  const { store, disk, root } = nativeFixture()
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', encoded('nested'))
  const file = store.internNode(parent, 'file', 'file', encoded('file'))
  const before = nativeScan(store, disk.id, disk.rootNode, file, 5000)
  store.changeHides(disk.id, {
    type: 'add',
    path: '/fixture/nested/hidden',
    components: [encoded('nested'), encoded('hidden')],
  })
  store.addExcludeRule(disk.id, { path: '/fixture/skip', components: [encoded('skip')] })
  store.recordDeleteOperation({
    operationId: 'saved-receipt',
    diskId: disk.id,
    payload: { scan: before },
    state: 'interrupted',
    receipt: { state: 'interrupted' },
  })
  store.setCleanupEnabled(disk.id, true)
  expect(store.stageDelete(disk.id, file).scanId).toBe(before)
  const history = store.listScans(disk.id),
    hides = store.hideSettings(disk.id),
    rules = store.excludeRules(disk.id),
    receipts = store.listDeleteOperations(disk.id)
  const refreshed = { ...root, identity: { ...root.identity, mount: '2' }, observedAt: 2 }
  expect(() => store.addNativeDisk(disk.machineId, refreshed)).toThrow(/Reinspect.*Settings/)
  expect(() => store.refreshNativeRoot(disk.id, { ...refreshed, pathBytes: encoded('/other') })).toThrow(
    /exact tracked root path/,
  )
  expect(store.refreshNativeRoot(disk.id, refreshed)).toMatchObject({
    id: disk.id,
    rootNode: disk.rootNode,
    nativeRoot: refreshed,
    cleanupEnabled: false,
  })
  expect(store.listScans(disk.id)).toEqual(history)
  expect(store.children(before, disk.rootNode)).toMatchObject([{ name: 'nested', size: 10 }])
  expect(store.hideSettings(disk.id)).toEqual(hides)
  expect(store.excludeRules(disk.id)).toEqual(rules)
  expect(store.listDeleteOperations(disk.id)).toEqual(receipts)
  store.setCleanupEnabled(disk.id, true)
  expect(() => store.stageDelete(disk.id, file)).toThrow(/after reinspection/)
  const after = nativeScan(store, disk.id, disk.rootNode, file, 1)
  expect(after).toBeGreaterThan(before)
  expect(store.stageDelete(disk.id, file)).toMatchObject({ scanId: after, rootIdentity: refreshed.identity })
  expect(() => store.compare(before, after)).toThrow(/different native root identities/)
  expect(() => store.diffChildren(before, after, disk.rootNode)).toThrow(/different native root identities/)
  expect(() => store.changes(before, after)).toThrow(/different native root identities/)
  expect(store.compare(before, before).rows).toEqual([])
  expect(store.compare(after, after).rows).toEqual([])
  store.db.close()
})

test('refreshing the same native identity still gates cleanup and fresh scan IDs survive deleted history', () => {
  const { store, disk, root } = nativeFixture()
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', encoded('nested'))
  const file = store.internNode(parent, 'file', 'file', encoded('file'))
  const before = nativeScan(store, disk.id, disk.rootNode, file, 5000)
  store.refreshNativeRoot(disk.id, root)
  store.setCleanupEnabled(disk.id, true)
  expect(() => store.stageDelete(disk.id, file)).toThrow(/after reinspection/)
  const comparable = nativeScan(store, disk.id, disk.rootNode, file, 1)
  expect(store.compare(before, comparable).rows).toMatchObject([
    { name: 'nested', before: { size: 10 }, after: { size: 10 } },
  ])
  store.refreshNativeRoot(disk.id, root)
  store.setCleanupEnabled(disk.id, true)
  expect(() => store.stageDelete(disk.id, file)).toThrow(/after reinspection/)
  store.deleteScan(before)
  store.deleteScan(comparable)
  store.refreshNativeRoot(disk.id, root)
  store.setCleanupEnabled(disk.id, true)
  const fresh = nativeScan(store, disk.id, disk.rootNode, file, 1)
  expect(fresh).toBeGreaterThan(comparable)
  expect(store.stageDelete(disk.id, file).scanId).toBe(fresh)
  expect(() => store.refreshNativeRoot(store.addDisk('C:\\').id, root)).toThrow(/native Unix/)
  store.db.close()
})

test('filesystem changes require explicit native refresh and separate Changes histories', () => {
  const { store, disk, root } = nativeFixture()
  const first = store.beginScan(disk.id, [])
  store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(first)
  const changed = { ...root, filesystem: 'otherfs' }
  expect(() => store.addNativeDisk(disk.machineId, changed)).toThrow(/Reinspect/)
  expect(() => store.beginScan(disk.id, [], changed)).toThrow(/changed/)
  store.refreshNativeRoot(disk.id, changed)
  const second = store.beginScan(disk.id, [])
  store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(second)
  expect(() => store.compare(first, second)).toThrow(/different native root identities or filesystems/)
  store.db.close()
})

test('partial native coverage stages only targets known to have no unreadable items, Windows unchanged', () => {
  const { store, disk } = nativeFixture()
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', encoded('nested'))
  const file = store.internNode(parent, 'file', 'file', encoded('file'))
  const folder = store.internNode(parent, 'dir', 'folder', encoded('folder'))
  const scan = nativeScan(store, disk.id, disk.rootNode, file, 1)
  store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,0,0)').run(scan, folder)
  store.setEntryIdentity(scan, folder, { device: '1', inode: '4' })
  const errorsAt = (node: number, errors: number | null) =>
    store.db.prepare('UPDATE entry SET subtree_errors=? WHERE scan_id=? AND node_id=?').run(errors, scan, node)
  store.setCleanupEnabled(disk.id, true)
  store.db.prepare("UPDATE scan SET coverage='partial' WHERE id=?").run(scan)
  // Scans from workers that predate per-folder error counts cannot show that a target was fully read.
  expect(() => store.stageDelete(disk.id, file)).toThrow(/does not record where.*Update the worker and scan again/)
  errorsAt(file, 0)
  expect(store.stageDelete(disk.id, file)).toMatchObject({ scanId: scan, partialScan: true })
  errorsAt(folder, 1)
  expect(() => store.stageDelete(disk.id, folder)).toThrow(/^1 item at or under this path could not be read/)
  errorsAt(folder, 8920)
  expect(() => store.stageDelete(disk.id, folder)).toThrow(/^8,920 items at or under this path could not be read/)
  errorsAt(folder, 0)
  expect(store.stageDelete(disk.id, folder)).toMatchObject({ kind: 'dir', partialScan: true })
  store.db.prepare("UPDATE scan SET coverage='complete' WHERE id=?").run(scan)
  errorsAt(file, null)
  const complete = store.stageDelete(disk.id, file)
  expect(complete.scanId).toBe(scan)
  expect(complete).not.toHaveProperty('partialScan')
  store.db.close()
  const windows = fixture()
  windows.store.db.prepare("UPDATE scan SET coverage='partial' WHERE id=?").run(windows.after)
  expect(windows.store.stageDelete(windows.disk.id, windows.cache).scanId).toBe(windows.after)
  windows.store.db.close()
})

test('version five history gains unknown per-entry read error counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-store-'))
  const file = join(dir, 'history.db')
  try {
    const store = new Store(openDb(file))
    const disk = store.addDisk('C:\\')
    const scan = store.beginScan(disk.id, [])
    store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,1,1)').run(scan, disk.rootNode)
    store.db.exec('ALTER TABLE entry DROP COLUMN subtree_errors; PRAGMA user_version=5')
    store.db.close()
    const upgraded = new Store(openDb(file))
    expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(upgraded.db.prepare('SELECT subtree_errors FROM entry WHERE scan_id=?').get(scan)).toEqual({
      subtree_errors: null,
    })
    upgraded.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search returns top-most name matches by literal, ASCII case-insensitive substring', () => {
  const f = fixture()
  const now = Date.now()
  const find = (nameContains: string) =>
    f.store.search(f.after, { nameContains, now }).rows.map((row) => [row.path, row.size, row.depth])
  expect(find('CACHE')).toEqual([['C:\\Footage\\Cache', 200, 2]])
  expect(find('o')).toEqual([['C:\\Footage', 230, 1]])
  expect(find('.bin')).toEqual([
    ['C:\\Footage\\Cache\\blob.bin', 200, 3],
    ['C:\\Fresh\\new.bin', 50, 2],
  ])
  expect(find('gone')).toEqual([])
  const percent = f.node(f.disk.rootNode, '100%_done', 'file')
  const lookalike = f.node(f.disk.rootNode, '100xxdone', 'file')
  const rest = f.node(f.footage, 'smaller files', 'rest')
  for (const id of [percent, lookalike, rest])
    f.store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,1,1)').run(f.after, id)
  expect(find('%_')).toEqual([['C:\\100%_done', 1, 1]])
  expect(find('0_')).toEqual([])
  expect(find('smaller')).toEqual([])
  expect(f.store.search(f.after, { now })).toEqual({ rows: [], total: 0 })
  expect(f.store.search(f.after, { nameContains: '', now })).toEqual({ rows: [], total: 0 })
  f.store.db.close()
})

test('search by age uses the given clock, folder write times and never matches unknown times', () => {
  const f = fixture()
  const day = 86_400_000
  const written = (id: number, days: number | null) =>
    f.store.db
      .prepare('UPDATE entry SET last_written_at=?, created_at=1 WHERE scan_id=? AND node_id=?')
      .run(days === null ? null : days * day, f.after, id)
  written(f.footage, 8)
  written(f.cache, 2)
  written(f.blob, 2)
  written(f.movie, 8)
  written(f.empty, null)
  written(f.fresh, 9)
  written(f.freshFile, 9)
  const now = 10 * day
  const older = (olderThanDays: number, nameContains?: string) =>
    f.store.search(f.after, { olderThanDays, nameContains, now }).rows.map((row) => row.name)
  expect(older(5)).toEqual(['Cache'])
  expect(older(1.5)).toEqual(['Footage'])
  expect(older(0)).toEqual(['Footage', 'Fresh'])
  expect(older(30)).toEqual([])
  expect(older(5, 'bin')).toEqual(['blob.bin'])
  expect(older(1.5, 'movie')).toEqual(['movie.mov'])
  expect(f.store.search(f.after, { olderThanDays: 5, now }).rows[0]).toMatchObject({
    nodeId: f.cache,
    kind: 'dir',
    files: 1,
    createdAt: 1,
    lastWrittenAt: 2 * day,
  })
  expect(() => f.store.search(f.after, { olderThanDays: -1, now })).toThrow(/days/)
  expect(() => f.store.search(f.after, { olderThanDays: Number.NaN, now })).toThrow(/days/)
  f.store.db.close()
})

test('search skips hidden paths, subtracts hidden sizes and reports the uncapped total', () => {
  const f = fixture()
  const now = Date.now()
  const { settings } = f.store.changeHides(f.disk.id, { type: 'add', path: 'C:\\Footage\\Cache' })
  expect(
    f.store
      .search(f.after, { nameContains: 'e', now, revision: settings.revision })
      .rows.map((row) => [row.name, row.size, row.files]),
  ).toEqual([
    ['Fresh', 50, 1],
    ['Footage', 30, 1],
    ['Empty', 0, 0],
  ])
  expect(f.store.search(f.after, { nameContains: 'bin', now }).rows.map((row) => row.name)).toEqual(['new.bin'])
  expect(() => f.store.search(f.after, { nameContains: 'bin', now, revision: settings.revision - 1 })).toThrow(
    /hidden paths changed/,
  )
  const capped = f.store.search(f.after, { nameContains: 'e', now }, 2)
  expect(capped.total).toBe(3)
  expect(capped.rows.map((row) => row.name)).toEqual(['Fresh', 'Footage'])
  f.store.db.close()
})

test('search labels Unix paths with the root separator and counts components below the root', () => {
  const { store, disk } = nativeFixture()
  const parent = store.internNode(disk.rootNode, 'dir', 'nested', encoded('nested'))
  const file = store.internNode(parent, 'file', 'Report.log', encoded('Report.log'))
  const scan = nativeScan(store, disk.id, disk.rootNode, file, 1)
  expect(store.search(scan, { nameContains: 'report', now: Date.now() }).rows).toMatchObject([
    { path: '/fixture/nested/Report.log', depth: 2 },
  ])
  store.db.close()
})
