import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test as platformTest } from 'vite-plus/test'
import { Store, openDb } from './store'
import { runScan, executeNativeDelete, recoverNativeDelete } from './scan'
import { LINUX_WORKER_UPDATE, workerOperation, type WorkerConnection } from './worker'
import { nativeRoot, workerInfo } from '../shared/workerProtocol'
import { unixLabel } from '../shared/paths'
import { selectedVolume, verifyVolume, volumeDiscovery } from './volumes'

const test = process.platform === 'win32' ? platformTest.skip : platformTest
const owned: string[] = []
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'disk-watch-controller-test-')))
  owned.push(directory)
  const root = join(directory, 'root')
  const outside = join(directory, 'outside')
  mkdirSync(join(root, 'deep'), { recursive: true, mode: 0o700 })
  mkdirSync(outside, { mode: 0o700 })
  writeFileSync(join(outside, 'sentinel'), 'safe')
  writeFileSync(join(root, 'deep/large'), Buffer.alloc(20, 65))
  writeFileSync(join(root, 'small'), 'one')
  symlinkSync(outside, join(root, 'deep/link'), 'dir')
  const raw = process.platform === 'linux' ? Buffer.from([110, 97, 109, 101, 255, 92, 10]) : Buffer.from('é\\\n')
  writeFileSync(Buffer.concat([Buffer.from(join(root, 'deep') + '/'), raw]), Buffer.alloc(12, 66))
  const store = new Store(openDb(':memory:'))
  let machine = {
    id: 'local-test',
    kind: 'local' as const,
    os: process.platform === 'darwin' ? ('macos' as const) : ('linux' as const),
    name: 'Owned test fixture',
  }
  const scannerExe = join(import.meta.dirname, '../../scanner/target/release/dw-scan')
  const stateDir = join(directory, 'state')
  const info = workerInfo(await workerOperation({ machine, scannerExe, stateDir }, 'hello'))
  const bound = store.upsertMachine({ ...machine, workerId: info.id, account: info.account })
  const connection: WorkerConnection = { machine: bound, scannerExe, stateDir }
  const rootInfo = nativeRoot(await workerOperation(connection, 'inspect', { path: root }))
  const disk = store.addNativeDisk(bound.id, rootInfo)
  const scan = (signal = new AbortController().signal) =>
    runScan({ store, scannerExe, stateDir, diskId: disk.id, minFileSize: 10, onProgress: () => {}, signal })
  return { directory, root, outside, store, connection, disk, rootInfo, raw, scan }
}

test('mounted-root discovery decodes and reinspects captured native identity without scanning', async () => {
  const f = await fixture()
  try {
    const result = volumeDiscovery(await workerOperation(f.connection, 'volumes'), f.connection.machine.os)
    expect(result.volumes.length).toBeGreaterThan(0)
    const choice =
      (f.connection.machine.os === 'macos'
        ? result.volumes.find((volume) => volume.path === '/System/Volumes/Data')
        : undefined) ?? result.volumes.find((volume) => volume.path === '/')
    expect(choice).toBeDefined()
    const saved = selectedVolume(result.volumes, { ...choice! })
    const inspected = nativeRoot(await workerOperation(f.connection, 'inspect', { pathBytes: saved.pathBytes }))
    verifyVolume(saved, inspected)
    expect(f.store.listScans(f.disk.id)).toEqual([])
    expect(f.store.getDisk(f.disk.id).cleanupEnabled).toBe(false)
  } finally {
    f.store.db.close()
  }
})

test('native controller preserves exact names, timestamps, grouping, history and byte exclusions', async () => {
  const f = await fixture()
  try {
    const first = await f.scan()
    expect(first.status).toBe('complete')
    expect(f.store.latestCompleteScan(f.disk.id)).toMatchObject({ size: 35, files: 3, coverage: 'complete' })
    const rows = f.store.children(first.scanId, f.disk.rootNode)
    const deep = rows.find((row) => row.name === 'deep')!
    const children = f.store.children(first.scanId, deep.nodeId)
    const raw = children.find((row) => row.name === unixLabel(f.raw.toString('base64')))!
    expect(raw).toMatchObject({ size: 12, files: 1, lastWrittenAt: expect.any(Number) })
    expect(f.store.nodeLocation(raw.nodeId).components).toEqual([
      Buffer.from('deep').toString('base64'),
      f.raw.toString('base64'),
    ])
    expect(
      f.store.db
        .prepare('SELECT native_identity FROM entry WHERE scan_id=? AND node_id=?')
        .get(first.scanId, raw.nodeId)?.native_identity,
    ).toBeTruthy()
    f.store.addExcludeRule(f.disk.id, f.store.nodeLocation(raw.nodeId))
    writeFileSync(join(f.root, 'deep/large'), Buffer.alloc(30, 65))
    const second = await f.scan()
    expect(second.status).toBe('complete')
    expect(f.store.latestCompleteScan(f.disk.id)).toMatchObject({ size: 33, files: 2 })
    expect(f.store.listScans(f.disk.id).find((scan) => scan.id === first.scanId)?.size).toBe(35)
    expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('safe')
  } finally {
    f.store.db.close()
  }
})

platformTest.skipIf(process.platform !== 'darwin')(
  'quick scans retain history, refresh changed files, and preserve cleanup validation',
  async () => {
    const f = await fixture()
    try {
      const quick = () =>
        runScan({
          store: f.store,
          scannerExe: f.connection.scannerExe,
          stateDir: f.connection.stateDir,
          diskId: f.disk.id,
          minFileSize: 10,
          incremental: true,
          onProgress: () => {},
          signal: new AbortController().signal,
        })
      const baseline = await quick()
      expect(baseline.status).toBe('complete')
      expect(f.store.latestCompleteScan(f.disk.id)?.method).toBe('walk')
      expect((await quick()).status).toBe('complete')
      expect(f.store.latestCompleteScan(f.disk.id)).toMatchObject({ method: 'incremental', size: 35, files: 3 })
      const deep = f.store.children(baseline.scanId, f.disk.rootNode).find((row) => row.name === 'deep')!
      const leaf = f.store.children(baseline.scanId, deep.nodeId).find((row) => row.name === 'large')!
      await workerOperation(f.connection, 'cleanup', { root: f.rootInfo, enabled: true })
      f.store.setCleanupEnabled(f.disk.id, true)
      const staged = f.store.stageDelete(f.disk.id, leaf.nodeId)
      // Replacing a cached file must still be rejected by the independent live deletion checks.
      const replacement = join(f.root, 'replacement')
      writeFileSync(replacement, Buffer.alloc(40))
      const { renameSync } = await import('node:fs')
      renameSync(replacement, join(f.root, 'deep/large'))
      const deleted = await executeNativeDelete(f.store, f.connection, f.disk.id, [staged])
      expect(deleted.failed).toHaveLength(1)
      expect(readFileSync(join(f.root, 'deep/large'))).toHaveLength(40)
      expect((await quick()).status).toBe('complete')
      expect(f.store.latestCompleteScan(f.disk.id)).toMatchObject({ size: 55, files: 3 })
      expect(f.store.listScans(f.disk.id).find((scan) => scan.id === baseline.scanId)?.size).toBe(35)
      expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('safe')
    } finally {
      f.store.db.close()
    }
  },
)

test('cancelled native scans retain previous complete history and commit no partial entries', async () => {
  const f = await fixture()
  try {
    const first = await f.scan()
    const controller = new AbortController()
    const pending = f.scan(controller.signal)
    controller.abort()
    const cancelled = await pending
    expect(cancelled.status).toBe('cancelled')
    expect(f.store.latestCompleteScan(f.disk.id)?.id).toBe(first.scanId)
    expect(f.store.db.prepare('SELECT count(*) AS count FROM entry WHERE scan_id=?').get(cancelled.scanId)?.count).toBe(
      0,
    )
  } finally {
    f.store.db.close()
  }
})

test('native cleanup uses saved identities and durable receipts without changing saved scans', async () => {
  const f = await fixture()
  try {
    const scanned = await f.scan()
    const deep = f.store.children(scanned.scanId, f.disk.rootNode).find((row) => row.name === 'deep')!
    const leaf = f.store.children(scanned.scanId, deep.nodeId).find((row) => row.name === 'large')!
    await workerOperation(f.connection, 'cleanup', { root: f.rootInfo, enabled: true })
    f.store.setCleanupEnabled(f.disk.id, true)
    const staged = f.store.stageDelete(f.disk.id, leaf.nodeId)
    const result = await executeNativeDelete(f.store, f.connection, f.disk.id, [staged])
    expect(result).toMatchObject({ state: 'completed', deleted: [staged.path], failed: [] })
    expect(f.store.listScans(f.disk.id)[0]?.size).toBe(35)
    writeFileSync(join(f.root, 'deep/large'), 'replacement')
    const receipt = await recoverNativeDelete(f.store, f.connection, result.operationId!)
    expect(receipt.state).toBe('completed')
    expect(readFileSync(join(f.root, 'deep/large'), 'utf8')).toBe('replacement')
    expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('safe')
  } finally {
    f.store.db.close()
  }
})

test('an out-of-date Linux worker leaves no uncertain deletion behind', async () => {
  const f = await fixture()
  try {
    const scanned = await f.scan()
    const deep = f.store.children(scanned.scanId, f.disk.rootNode).find((row) => row.name === 'deep')!
    const leaf = f.store.children(scanned.scanId, deep.nodeId).find((row) => row.name === 'large')!
    await workerOperation(f.connection, 'cleanup', { root: f.rootInfo, enabled: true })
    f.store.setCleanupEnabled(f.disk.id, true)
    const staged = f.store.stageDelete(f.disk.id, leaf.nodeId)
    // Stands in for a Linux worker built before per-folder trust checks. It answers `hello` only.
    const oldWorker = join(f.directory, 'old-worker')
    const received = join(f.directory, 'received')
    writeFileSync(
      oldWorker,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const { workerId: id, account } = ${JSON.stringify(f.connection.machine)};
const worker = { id, account, os: 'linux', version: 1, capabilities: { scan: true, delete: true } };
createInterface({ input: process.stdin }).once('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(received)}, request.op + '\\n');
  const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
  send({ t: 'hello', v: 1, requestId: request.requestId, worker });
  send({ t: 'result', value: worker });
  process.stdout.end(() => process.exit(0));
});
`,
      { mode: 0o700 },
    )
    const old: WorkerConnection = {
      ...f.connection,
      machine: { ...f.connection.machine, os: 'linux' },
      scannerExe: oldWorker,
    }
    const failure = executeNativeDelete(f.store, old, f.disk.id, [staged])
    await expect(failure).rejects.toThrow(LINUX_WORKER_UPDATE)
    await expect(failure).rejects.not.toThrow(/uncertain/)
    expect(readFileSync(received, 'utf8')).toBe('hello\n')
    // Nothing was sent, so nothing needs a status check before the next deletion.
    expect(f.store.listDeleteOperations(f.disk.id)).toEqual([])
    expect(readFileSync(join(f.root, 'deep/large'))).toHaveLength(20)
  } finally {
    f.store.db.close()
  }
})
