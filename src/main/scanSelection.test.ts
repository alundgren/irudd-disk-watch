import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { openDb, Store } from './store'

function local(store: Store) {
  return store.upsertMachine({ id: 'fixture-local', kind: 'local', os: 'windows', name: 'Fixture' })
}

test('existing and new roots default included, selection persists across reopen, history remains literal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dw-selection-'))
  const file = join(directory, 'history.db')
  let store = new Store(openDb(file))
  try {
    const machine = local(store)
    const first = store.addDisk('C:\\Fixture', machine.id)
    const oldScan = store.beginScan(first.id, [])
    store.db.prepare("UPDATE scan SET status='complete' WHERE id=?").run(oldScan)
    const snapshot = store.latestCompleteScan(first.id)
    // A real schema-six database has no selection column.
    store.db.exec('ALTER TABLE disk DROP COLUMN scan_included; PRAGMA user_version=6')
    store.db.close()
    store = new Store(openDb(file))
    expect(store.getDisk(first.id).scanIncluded).toBe(true)
    const second = store.addDisk('D:\\Fixture', machine.id)
    const historical = store.addDisk('E:\\History')
    expect(second.scanIncluded).toBe(true)
    expect(store.selectedScanDisks().map((disk) => disk.id)).toEqual([first.id, second.id])
    store.setScanIncluded(first.id, false)
    expect(store.latestCompleteScan(first.id)).toEqual(snapshot)
    store.db.close()
    store = new Store(openDb(file))
    expect(store.getDisk(first.id).scanIncluded).toBe(false)
    expect(store.addDisk('C:\\Fixture', machine.id).scanIncluded).toBe(false)
    expect(store.getDisk(historical.id).machine.kind).toBe('historical')
    expect(store.selectedScanDisks().map((disk) => disk.id)).toEqual([second.id])
    store.setScanIncluded(second.id, false)
    expect(store.selectedScanDisks()).toEqual([])
    expect(store.latestCompleteScan(first.id)).toEqual(snapshot)
  } finally {
    store.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('selection validates root IDs and booleans, rejects history and invalid persisted preferences', () => {
  const store = new Store(openDb(':memory:'))
  try {
    const live = store.addDisk('C:\\Fixture', local(store).id)
    const historical = store.addDisk('D:\\History')
    for (const id of [0, -1, 1.5, NaN, Infinity, '1', null, live.id + 100])
      expect(() => store.setScanIncluded(id as number, true)).toThrow()
    for (const included of [0, 1, 'false', null, undefined])
      expect(() => store.setScanIncluded(live.id, included as unknown as boolean)).toThrow(/preference/)
    expect(() => store.setScanIncluded(historical.id, false)).toThrow(/history/)
    expect(() => store.db.prepare('UPDATE disk SET scan_included=2 WHERE id=?').run(live.id)).toThrow()
    expect(store.selectedScanDisks().map((disk) => disk.id)).toEqual([live.id])
  } finally {
    store.db.close()
  }
})
