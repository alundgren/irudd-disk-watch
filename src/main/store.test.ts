import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { canDeletePath, canonicalPath, deletePath, hidePath, pathAncestors } from '../shared/paths'
import { openDb, Store } from './store'

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
    const store = new Store(openDb(file))
    const disk = store.addDisk('D:\\Legacy')
    const folder = Number(
      store.db.prepare("INSERT INTO node(parent,name,kind) VALUES(?,'Folder','dir')").run(disk.rootNode)
        .lastInsertRowid,
    )
    const scan = store.beginScan(disk.id, [])
    store.db.prepare("UPDATE scan SET status='complete',size=17,files=2 WHERE id=?").run(scan)
    for (const node of [disk.rootNode, folder])
      store.db.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,17,2)').run(scan, node)
    store.db.exec(
      'ALTER TABLE entry DROP COLUMN created_at; ALTER TABLE entry DROP COLUMN last_written_at; PRAGMA user_version=2;',
    )
    store.db.close()
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
    const fresh = openDb(file)
    const legacy = new Store(fresh)
    const existing = legacy.addDisk('D:\\Legacy')
    fresh.prepare('INSERT INTO exclude VALUES(?,?)').run(existing.id, 'D:\\Legacy\\Skip')
    const oldScan = legacy.beginScan(existing.id, ['D:\\Legacy\\Skip'])
    fresh.prepare("UPDATE scan SET status='complete',size=17,files=2 WHERE id=?").run(oldScan)
    fresh.prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,17,2)').run(oldScan, existing.rootNode)
    fresh.exec(
      'ALTER TABLE entry DROP COLUMN created_at; ALTER TABLE entry DROP COLUMN last_written_at; DROP TABLE view_hide; ALTER TABLE disk DROP COLUMN hide_metadata; ALTER TABLE disk DROP COLUMN hide_revision; PRAGMA user_version=1;',
    )
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
    expect(reopened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
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
