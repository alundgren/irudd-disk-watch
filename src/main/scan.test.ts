import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { runScan } from './scan'
import { openDb, Store } from './store'

const scannerExe = join(import.meta.dirname, '../../scanner/target/release/dw-scan.exe')

let root: string
let store: Store

function write(path: string, bytes: number) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), Buffer.alloc(bytes))
}

function scan(diskId: number, signal = new AbortController().signal) {
  return runScan({ store, scannerExe, diskId, minFileSize: 1000, onProgress: () => {}, signal })
}

function childrenByName(scanId: number, nodeId: number) {
  return Object.fromEntries(
    store.children(scanId, nodeId).map((row) => [row.kind === 'rest' ? '(small files)' : row.name, row]),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dw-test-'))
  store = new Store(openDb(':memory:'))
  write('footage/a.mov', 5000)
  write('footage/notes.txt', 10)
  write('footage/thumb.jpg', 20)
  write('cache/blob.bin', 3000)
  write('skipme/huge.bin', 9000)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test('a scan stores folder totals, big files, and folds small files', async () => {
  const disk = store.addDisk(root)
  store.setExcludes(disk.id, [join(root, 'SKIPME')])

  const outcome = await scan(disk.id)

  expect(outcome.status).toBe('complete')
  expect(store.listScans(disk.id)[0]).toMatchObject({ status: 'complete', size: 8030, files: 4, dirs: 3 })
  const top = childrenByName(outcome.scanId, disk.rootNode)
  expect(Object.keys(top)).toEqual(['footage', 'cache'])
  expect(top.footage).toMatchObject({ kind: 'dir', size: 5030, files: 3 })
  const footage = childrenByName(outcome.scanId, top.footage!.nodeId)
  expect(footage).toEqual({
    'a.mov': { nodeId: expect.any(Number), name: 'a.mov', kind: 'file', size: 5000, files: 1 },
    '(small files)': { nodeId: expect.any(Number), name: '', kind: 'rest', size: 30, files: 2 },
  })
  expect(store.nodePath(footage['a.mov']!.nodeId)).toBe(join(root, 'footage', 'a.mov'))
})

test('a rescan keeps the old tree and explains what came and went', async () => {
  const disk = store.addDisk(root)
  const first = await scan(disk.id)
  write('footage/b.mov', 7000)
  write('renders/final.mp4', 4000)
  rmSync(join(root, 'cache'), { recursive: true })

  const second = await scan(disk.id)

  const before = childrenByName(first.scanId, disk.rootNode)
  expect(Object.keys(before)).toEqual(['skipme', 'footage', 'cache'])
  const diff = store.diffChildren(first.scanId, second.scanId, disk.rootNode)
  expect(diff.map(({ name, before, after }) => ({ name, before, after }))).toEqual([
    { name: 'footage', before: { size: 5030, files: 3 }, after: { size: 12030, files: 4 } },
    { name: 'renders', before: null, after: { size: 4000, files: 1 } },
    { name: 'cache', before: { size: 3000, files: 1 }, after: null },
    { name: 'skipme', before: { size: 9000, files: 1 }, after: { size: 9000, files: 1 } },
  ])
  const changes = store.changes(first.scanId, second.scanId)
  expect(changes.grownFolders.map(({ path, before, after }) => ({ path, before, after }))).toEqual([
    { path: join(root, 'footage'), before: 5030, after: 12030 },
    { path: join(root, 'renders'), before: 0, after: 4000 },
  ])
  expect(changes.newFolders.map(({ path, after }) => ({ path, after }))).toEqual([
    { path: join(root, 'renders'), after: 4000 },
  ])
})

test('a cancelled scan leaves no rows behind', async () => {
  const disk = store.addDisk(root)
  const controller = new AbortController()
  controller.abort()

  const outcome = await scan(disk.id, controller.signal)

  expect(outcome.status).toBe('cancelled')
  expect(store.children(outcome.scanId, disk.rootNode)).toEqual([])
  expect(store.latestCompleteScan(disk.id)).toBeNull()
})
