// Builds a synthetic scan in a temp database and times Space filter queries.
// Usage: node scripts/bench-search.ts [nodes, default 2000000]
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/store.ts'

const target = Number(process.argv[2] ?? 2_000_000)
const dir = mkdtempSync(join(tmpdir(), 'dw-bench-search-'))
try {
  const store = new Store(openDb(join(dir, 'bench.db')))
  const disk = store.addDisk('C:\\')
  const scanId = store.beginScan(disk.id, [])
  const day = 86_400_000
  const now = 1_800_000_000_000
  const node = store.db.prepare('INSERT INTO node(id,parent,name,kind,identity_key) VALUES(?,?,?,?,?)')
  const entry = store.db.prepare(
    'INSERT INTO entry(scan_id,node_id,size,files,created_at,last_written_at) VALUES(?,?,?,?,?,?)',
  )
  const started = performance.now()
  store.db.exec('BEGIN')
  // 200 top folders, 100 subfolders each, then files; ages spread over two years.
  let id = disk.rootNode + 1
  let count = 1
  const perLeaf = Math.max(1, Math.floor(target / 20_000) - 1)
  let total = 0
  for (let a = 0; a < 200; a++) {
    const top = id++
    node.run(top, disk.rootNode, `project-${a}`, 'dir', `w:project-${a}`)
    let topSize = 0
    let topWritten = 0
    for (let b = 0; b < 100; b++) {
      const sub = id++
      const name = b % 10 === 0 ? `node_modules-${b}` : `module-${b}`
      node.run(sub, top, name, 'dir', `w:${name}`)
      let subSize = 0
      let subWritten = 0
      for (let c = 0; c < perLeaf; c++) {
        const file = id++
        const size = ((a * 7919 + b * 104729 + c * 31) % 50_000_000) + 1
        const written = now - ((a * 13 + b * 7 + c) % 730) * day
        node.run(file, sub, `file-${c}.bin`, 'file', `w:file-${c}.bin`)
        entry.run(scanId, file, size, 1, written - day, written)
        subSize += size
        subWritten = Math.max(subWritten, written)
      }
      entry.run(scanId, sub, subSize, perLeaf, null, subWritten)
      topSize += subSize
      topWritten = Math.max(topWritten, subWritten)
      count += perLeaf + 1
    }
    entry.run(scanId, top, topSize, perLeaf * 100, null, topWritten)
    total += topSize
    count++
  }
  entry.run(scanId, disk.rootNode, total, perLeaf * 20_000, null, now)
  store.db.prepare("UPDATE scan SET status='complete',size=?,files=? WHERE id=?").run(total, perLeaf * 20_000, scanId)
  store.db.exec('COMMIT')
  console.log(`built ${count.toLocaleString('en-US')} nodes in ${((performance.now() - started) / 1000).toFixed(1)} s`)

  const queries = [
    { nameContains: 'node_modules' },
    { nameContains: 'file-1' },
    { nameContains: 'no match at all' },
    { olderThanDays: 365 },
    { olderThanDays: 700, nameContains: '.bin' },
  ]
  for (const query of queries) {
    const begin = performance.now()
    const result = store.search(scanId, { ...query, now })
    console.log(
      `${JSON.stringify(query)}: ${result.total.toLocaleString('en-US')} matches, ` +
        `${result.rows.length} returned in ${(performance.now() - begin).toFixed(0)} ms`,
    )
  }
  store.db.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
