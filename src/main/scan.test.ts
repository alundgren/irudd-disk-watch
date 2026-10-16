import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test as platformTest, vi } from 'vite-plus/test'
import { executeDelete, runScan } from './scan'
import { openDb, Store } from './store'
import { holdFile } from '../../scripts/fixtureLock.ts'

vi.mock('node:child_process', { spy: true })

const test = process.platform === 'win32' ? platformTest : platformTest.skip

const scannerExe = join(import.meta.dirname, '../../scanner/target/release/dw-scan.exe')

let root: string
let store: Store

function write(path: string, bytes: number) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), Buffer.alloc(bytes))
}

function scan(diskId: number, signal = new AbortController().signal) {
  return runScan({ store, scannerExe, diskId, minFileSize: 1000, method: 'walk', onProgress: () => {}, signal })
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
  expect(store.listScans(disk.id)[0]).toMatchObject({
    status: 'complete',
    method: 'walk',
    size: 8030,
    files: 4,
    dirs: 3,
  })
  const top = childrenByName(outcome.scanId, disk.rootNode)
  expect(Object.keys(top)).toEqual(['footage', 'cache'])
  expect(top.footage).toMatchObject({ kind: 'dir', size: 5030, files: 3 })
  const footage = childrenByName(outcome.scanId, top.footage!.nodeId)
  expect(footage).toEqual({
    'a.mov': {
      nodeId: expect.any(Number),
      name: 'a.mov',
      kind: 'file',
      size: 5000,
      files: 1,
      createdAt: expect.any(Number),
      lastWrittenAt: expect.any(Number),
    },
    '(small files)': {
      nodeId: expect.any(Number),
      name: '',
      kind: 'rest',
      size: 30,
      files: 2,
      createdAt: null,
      lastWrittenAt: null,
    },
  })
  expect(store.nodePath(footage['a.mov']!.nodeId)).toBe(join(root, 'footage', 'a.mov'))
})

test('in-place small writes reach ancestors, preserve folder creation and old snapshots, and reject future writes', async () => {
  write('footage/nested/state.txt', 10)
  const old = new Date(Date.now() - 60_000)
  for (const path of [
    'footage/a.mov',
    'footage/notes.txt',
    'footage/thumb.jpg',
    'footage/nested/state.txt',
    'footage/nested',
    'footage',
  ])
    utimesSync(join(root, path), old, old)
  const folder = join(root, 'footage')
  const childFolder = join(folder, 'nested')
  const small = join(childFolder, 'state.txt')
  const oldWrite = Math.floor(statSync(small).mtimeMs)
  const birth = Math.floor(statSync(folder).birthtimeMs)
  const future = new Date(Date.now() + 86_400_000)
  utimesSync(join(folder, 'a.mov'), future, future)
  const disk = store.addDisk(root)
  const first = await scan(disk.id)
  const before = childrenByName(first.scanId, disk.rootNode).footage!
  expect(before).toMatchObject({ createdAt: birth, lastWrittenAt: oldWrite })
  const nestedBefore = childrenByName(first.scanId, before.nodeId).nested!
  writeFileSync(small, Buffer.alloc(20))
  const latest = new Date(Date.now() - 1000)
  utimesSync(small, latest, latest)
  expect(Math.floor(statSync(childFolder).mtimeMs)).toBe(oldWrite)
  const latestWrite = Math.floor(statSync(small).mtimeMs)
  const second = await scan(disk.id)
  const after = childrenByName(second.scanId, disk.rootNode).footage!
  expect(after).toMatchObject({ createdAt: birth, lastWrittenAt: latestWrite })
  expect(childrenByName(second.scanId, after.nodeId).nested).toMatchObject({
    createdAt: nestedBefore.createdAt,
    lastWrittenAt: latestWrite,
  })
  expect(childrenByName(second.scanId, after.nodeId)['a.mov']!.lastWrittenAt).toBeNull()
  expect(childrenByName(first.scanId, disk.rootNode).footage).toEqual(before)
  expect(childrenByName(second.scanId, nestedBefore.nodeId)['(small files)']).toMatchObject({ files: 1, size: 20 })
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

test('walk scans skip exact file paths before counting or grouping, while retaining similarly named files', async () => {
  write('hiberfil.sys', 10000)
  write('hiberfil.sys.backup', 2000)
  write('footage/swapfile.sys', 3000)
  const disk = store.addDisk(root)
  store.setExcludes(
    disk.id,
    ['hiberfil.sys', 'footage/a.mov', 'footage/swapfile.sys', 'footage/notes.txt', 'skipme'].map((path) =>
      join(root, path).toUpperCase().replaceAll('\\', '/'),
    ),
  )
  const outcome = await scan(disk.id)
  expect(outcome.status).toBe('complete')
  expect(store.latestCompleteScan(disk.id)).toMatchObject({ method: 'walk', size: 5020, files: 3, dirs: 3 })
  const top = childrenByName(outcome.scanId, disk.rootNode)
  expect(Object.keys(top)).toEqual(['cache', 'hiberfil.sys.backup', 'footage'])
  expect(top.footage).toMatchObject({ size: 20, files: 1 })
  expect(childrenByName(outcome.scanId, top.footage!.nodeId)).toEqual({
    '(small files)': {
      nodeId: expect.any(Number),
      name: '',
      kind: 'rest',
      size: 20,
      files: 1,
      createdAt: null,
      lastWrittenAt: null,
    },
  })
})

test('a cancelled scan leaves no rows behind', async () => {
  const disk = store.addDisk(root)
  const controller = new AbortController()
  controller.abort()
  vi.mocked(spawn).mockClear()

  const outcome = await scan(disk.id, controller.signal)

  expect(outcome.status).toBe('cancelled')
  expect(spawn).not.toHaveBeenCalled()
  expect(store.children(outcome.scanId, disk.rootNode)).toEqual([])
  expect(store.latestCompleteScan(disk.id)).toBeNull()
})

test('executeDelete removes nested items and leaves every captured scan unchanged', async () => {
  const disk = store.addDisk(root)
  for (let i = 0; i < 50; i++) write(`footage/node_modules/pkg-${i}/index.js`, 64)
  const initial = await scan(disk.id)
  const capturedScans = store.listScans(disk.id)
  const capturedEntries = store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()
  const footage = store.children(initial.scanId, disk.rootNode).find((row) => row.name === 'footage')!
  expect(() => store.stageDelete(disk.id, disk.rootNode)).toThrow(/top-level/)
  expect(() => store.stageDelete(disk.id, footage.nodeId)).toThrow(/top-level/)
  const children = store.children(initial.scanId, footage.nodeId)
  const stage = (name: string) => store.stageDelete(disk.id, children.find((row) => row.name === name)!.nodeId)
  const targetDir = join(root, 'footage', 'node_modules')
  const targetFile = join(root, 'footage', 'a.mov')
  const parent = stage('node_modules')
  const child = store.children(initial.scanId, parent.nodeId)[0]!
  const result = await executeDelete(store, scannerExe, disk.id, [
    parent,
    store.stageDelete(disk.id, child.nodeId),
    stage('a.mov'),
  ])
  expect(result).toEqual({ deleted: [targetDir, targetFile], failed: [] })
  expect(existsSync(targetDir)).toBe(false)
  expect(existsSync(targetFile)).toBe(false)
  expect(existsSync(join(root, 'footage', 'notes.txt'))).toBe(true)
  expect(store.listScans(disk.id)).toEqual(capturedScans)
  expect(store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()).toEqual(capturedEntries)
})

test('deletion refuses ancestor junction traversal, unlinks leaf junctions and preserves outside files', async () => {
  const disk = store.addDisk(root)
  write('footage/alias/victim/sentinel.txt', 2000)
  write('footage/leaf/old.bin', 2000)
  write('footage/tree/inner/old.bin', 2000)
  await scan(disk.id)
  const node = (path: string) =>
    (store.db.prepare('SELECT id FROM node').all() as { id: number }[]).find((row) => store.nodePath(row.id) === path)!
      .id
  const through = store.stageDelete(disk.id, node(join(root, 'footage', 'alias', 'victim')))
  const leaf = store.stageDelete(disk.id, node(join(root, 'footage', 'leaf')))
  const tree = store.stageDelete(disk.id, node(join(root, 'footage', 'tree')))
  const outside = mkdtempSync(join(tmpdir(), 'dw-outside-'))
  mkdirSync(join(outside, 'victim'))
  writeFileSync(join(outside, 'victim', 'sentinel.txt'), 'outside remains')
  rmSync(join(root, 'footage', 'alias'), { recursive: true })
  rmSync(join(root, 'footage', 'leaf'), { recursive: true })
  rmSync(join(root, 'footage', 'tree', 'inner'), { recursive: true })
  symlinkSync(outside, join(root, 'footage', 'alias'), 'junction')
  symlinkSync(outside, join(root, 'footage', 'leaf'), 'junction')
  symlinkSync(outside, join(root, 'footage', 'tree', 'inner'), 'junction')
  try {
    const result = await executeDelete(store, scannerExe, disk.id, [through, leaf, tree])
    expect(result.deleted).toEqual([leaf.path, tree.path])
    expect(result.failed).toMatchObject([
      {
        path: through.path,
        message: expect.stringMatching(/reparse/),
        failedPath: join(root, 'footage', 'alias'),
        lockInfo: { status: 'not_checked' },
      },
    ])
    expect(readFileSync(join(outside, 'victim', 'sentinel.txt'), 'utf8')).toBe('outside remains')
    expect(existsSync(leaf.path)).toBe(false)
    expect(existsSync(tree.path)).toBe(false)
  } finally {
    rmSync(join(root, 'footage', 'alias'))
    rmSync(outside, { recursive: true, force: true })
  }
})

test('deletion rejects stale scans before any filesystem work and preserves file-to-folder replacements', async () => {
  const disk = store.addDisk(root)
  const first = await scan(disk.id)
  const footage = store.children(first.scanId, disk.rootNode).find((row) => row.name === 'footage')!
  const movieId = store.children(first.scanId, footage.nodeId).find((row) => row.name === 'a.mov')!.nodeId
  const old = store.stageDelete(disk.id, movieId)
  await scan(disk.id)
  await expect(executeDelete(store, scannerExe, disk.id, [old])).rejects.toThrow(/changed/)
  expect(existsSync(old.path)).toBe(true)
  const current = store.stageDelete(disk.id, movieId)
  rmSync(current.path)
  mkdirSync(current.path)
  writeFileSync(join(current.path, 'keep.txt'), 'new folder contents')
  const result = await executeDelete(store, scannerExe, disk.id, [current])
  expect(result.deleted).toEqual([])
  expect(result.failed[0]).toMatchObject({ path: current.path, message: expect.stringMatching(/type changed/) })
  expect(readFileSync(join(current.path, 'keep.txt'), 'utf8')).toBe('new folder contents')
})

test('deletion preserves the locked child path and identifies its process across the scanner boundary', async () => {
  const disk = store.addDisk(root)
  write('footage/exports/locked.txt', 2000)
  write('footage/exports/good.txt', 2000)
  const initial = await scan(disk.id)
  const footage = store.children(initial.scanId, disk.rootNode).find((row) => row.name === 'footage')!
  const folder = store.children(initial.scanId, footage.nodeId).find((row) => row.name === 'exports')!
  const target = store.stageDelete(disk.id, folder.nodeId)
  const locked = join(root, 'footage', 'exports', 'locked.txt')
  const lock = await holdFile(locked)
  const captured = store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()
  try {
    const result = await executeDelete(store, scannerExe, disk.id, [target])
    expect(result.deleted).toEqual([])
    expect(result.failed[0]).toMatchObject({
      path: target.path,
      failedPath: locked,
      errorCode: 32,
      lockInfo: {
        status: 'found',
        processes: expect.arrayContaining([
          expect.objectContaining({
            pid: lock.pid,
            processName: 'powershell.exe',
            executablePath: expect.stringMatching(/powershell\.exe$/i),
            programName: expect.any(String),
          }),
        ]),
      },
    })
    expect(existsSync(join(root, 'footage', 'exports', 'good.txt'))).toBe(false)
    expect(existsSync(locked)).toBe(true)
    expect(store.db.prepare('SELECT * FROM entry ORDER BY scan_id,node_id').all()).toEqual(captured)
  } finally {
    await lock.release()
  }
  expect((await executeDelete(store, scannerExe, disk.id, [target])).deleted).toEqual([target.path])
})

test('deletion validates diagnostic metadata and supports older scanner failures', async () => {
  const disk = store.addDisk(root)
  const initial = await scan(disk.id)
  const footage = store.children(initial.scanId, disk.rootNode).find((row) => row.name === 'footage')!
  const file = store.children(initial.scanId, footage.nodeId).find((row) => row.name === 'a.mov')!
  const target = store.stageDelete(disk.id, file.nodeId)
  const actualSpawn = spawn
  const reply = (failure: unknown) => {
    const json = JSON.stringify({ deleted: [], failed: [failure] })
    vi.mocked(spawn).mockImplementationOnce(() =>
      actualSpawn(
        process.execPath,
        [
          '-e',
          'process.stdin.resume(); process.stdin.on("end",()=>{console.log(process.argv[1]);process.exitCode=1})',
          json,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
    )
  }
  const failure = { path: target.path, message: 'Locked' }
  reply(failure)
  expect((await executeDelete(store, scannerExe, disk.id, [target])).failed).toEqual([failure])
  reply({
    ...failure,
    failedPath: root,
    errorCode: 32,
    lockInfo: { status: 'none', processes: [], note: 'Owner exited.' },
  })
  expect((await executeDelete(store, scannerExe, disk.id, [target])).failed[0]?.failedPath).toBe(root)
  for (const extra of [
    { failedPath: join(root, 'cache', 'blob.bin') },
    { errorCode: '32' },
    { lockInfo: { status: 'found', processes: [], note: 'Invalid' } },
    { lockInfo: { status: ['none'], processes: [], note: 'Invalid' } },
    {
      lockInfo: {
        status: 'found',
        note: 'Invalid',
        processes: [
          {
            pid: 12,
            source: ['restart_manager'],
            processName: null,
            programName: null,
            executablePath: null,
            serviceName: null,
            note: null,
          },
        ],
      },
    },
    { lockInfo: { status: 'none', processes: [{ pid: -1 }], note: 'Invalid' } },
    {
      lockInfo: { status: 'found', processes: [{ pid: 12, source: 'open_handle', processName: 42 }], note: 'Invalid' },
    },
  ]) {
    reply({ ...failure, ...extra })
    await expect(executeDelete(store, scannerExe, disk.id, [target])).rejects.toThrow(/Invalid/)
  }
})
