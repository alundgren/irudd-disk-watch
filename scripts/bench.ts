// Scans a real drive twice through the app's ingest path into a temp database and
// reports timings, database growth, and a diff query.
// Usage: node scripts/bench.ts C:\
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runScan } from '../src/main/scan.ts'
import { openDb, Store } from '../src/main/store.ts'

const root = process.argv[2] ?? 'C:\\'
const dir = mkdtempSync(join(tmpdir(), 'dw-bench-'))
const dbFile = join(dir, 'bench.db')
const store = new Store(openDb(dbFile))
const disk = store.addDisk(root)
const scannerExe = join(import.meta.dirname, '../scanner/target/release/dw-scan.exe')
const dbSize = () => statSync(dbFile).size + statSync(`${dbFile}-wal`, { throwIfNoEntry: false })?.size!

const scanIds: number[] = []
for (const label of ['first scan', 'second scan']) {
  const started = performance.now()
  let walkedAt = 0
  const outcome = await runScan({
    store,
    scannerExe,
    diskId: disk.id,
    minFileSize: 1024 * 1024,
    signal: new AbortController().signal,
    onProgress: (p) => {
      if (p.phase === 'saving' && !walkedAt) walkedAt = performance.now()
    },
  })
  const total = performance.now() - started
  const scan = store.listScans(disk.id)[0]!
  console.log(
    `${label}: ${outcome.status} ${outcome.message ?? ''} total ${(total / 1000).toFixed(1)} s, ` +
      `walk ${((walkedAt - started) / 1000).toFixed(1)} s, save ${((total - (walkedAt - started)) / 1000).toFixed(1)} s, ` +
      `${scan.files} files, ${scan.dirs} dirs, db ${(dbSize() / 1e6).toFixed(0)} MB`,
  )
  scanIds.push(outcome.scanId)
}

const [first, second] = scanIds as [number, number]
let started = performance.now()
store.children(second, disk.rootNode)
console.log(`children of root: ${(performance.now() - started).toFixed(0)} ms`)
started = performance.now()
store.diffChildren(first, second, disk.rootNode)
console.log(`diff children of root: ${(performance.now() - started).toFixed(0)} ms`)
started = performance.now()
const changes = store.changes(first, second)
console.log(`changes: ${(performance.now() - started).toFixed(0)} ms`, changes.grownFolders.slice(0, 3))
store.db.close()
rmSync(dir, { recursive: true, force: true })
