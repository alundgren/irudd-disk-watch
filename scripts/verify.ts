// Drives the built app end to end against a temp folder and saves screenshots.
// Usage: vp run verify [screenshot dir]
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { openDb, Store } from '../src/main/store.ts'
import { holdFile } from './fixtureLock.ts'

const MB = 1024 * 1024
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dw-shots-'))
const userData = mkdtempSync(join(tmpdir(), 'dw-userdata-'))
const root = mkdtempSync(join(tmpdir(), 'dw-fixture-'))
const second = mkdtempSync(join(tmpdir(), 'dw-second-'))
writeFileSync(join(second, 'render.mp4'), Buffer.alloc(3 * MB))

function write(path: string, bytes: number) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), Buffer.alloc(bytes))
}

write('Footage/day1/A001.mov', 40 * MB)
write('Footage/day1/A002.mov', 25 * MB)
write('Projects/edit.prproj', 2 * MB)
for (let i = 0; i < 300; i++) write(`Projects/cache/peak${i}.pek`, 4000)
write('Downloads/installer.exe', 12 * MB)
write('Temp/scratch.bin', 30 * MB)
write('unlisted.txt', 100)

const store = new Store(openDb(join(userData, 'disk-watch-native.db')))
store.setExcludes(store.addDisk(root).id, [join(root, 'Temp')])
store.addDisk(second)
store.db.close()

// Set when this runs from inside another Electron app; it would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
let app = await electron.launch({
  executablePath: join(import.meta.dirname, '../node_modules/electron/dist/electron.exe'),
  args: [join(import.meta.dirname, '..'), `--user-data-dir=${userData}`],
  env: { ...env, DISK_WATCH_VERIFY: '1' },
})
try {
  let page = await app.firstWindow()
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())),
    false,
    'verification must not show a desktop window',
  )
  page.on('pageerror', (err) => console.error('pageerror', err))
  await page.setViewportSize({ width: 1280, height: 820 })

  async function scan(page: Page) {
    await page.evaluate(() => {
      const state = window as unknown as { fixtureScanFinished: boolean }
      state.fixtureScanFinished = false
      const unsubscribe = window.diskWatch.onScanEvent((event) => {
        if (event.type === 'run-finished') {
          state.fixtureScanFinished = true
          unsubscribe()
        }
      })
    })
    await page.getByRole('button', { name: 'Scan all drives' }).click()
    await page.waitForFunction(
      () => (window as unknown as { fixtureScanFinished: boolean }).fixtureScanFinished,
      undefined,
      { timeout: 60_000, polling: 100 },
    )
    await page.getByRole('button', { name: 'Scan all drives' }).waitFor({ timeout: 60_000 })
    await page.getByText(/Loading (view|comparison)/).waitFor({ state: 'hidden' })
    const methods = await page.evaluate(async () =>
      (await window.diskWatch.listDisks()).map((disk) => disk.latestScan?.method),
    )
    assert.ok(
      methods.length > 0 && methods.every((method) => method === 'walk'),
      'verification scans use the folder walker',
    )
  }

  await page.getByText('No scans yet').waitFor()
  await page.screenshot({ path: join(shots, '1-empty.png') })
  await scan(page)
  await page
    .getByText(/scanned \d/)
    .nth(1)
    .waitFor({ timeout: 5000 })
  assert.equal(await page.getByText('never scanned').count(), 0, 'one click scans every tracked folder')
  assert.equal(await page.getByRole('treeitem').count(), 3, 'root aggregate is not a visible row')

  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await page.getByRole('treeitem', { name: /A001\.mov/ }).waitFor()
  await page.getByRole('treeitem', { name: /Projects/ }).click()
  await page.getByRole('treeitem', { name: /cache/ }).click()
  assert.match(await page.getByRole('treeitem', { name: /cache/ }).innerText(), /1\.14 MB\s+300/)
  assert.equal(await page.getByRole('treeitem', { name: /smaller files/ }).count(), 0)
  assert.equal(await page.getByText('Empty folder', { exact: true }).count(), 0, 'aggregate-only folder is not empty')
  assert.equal(await page.getByRole('treeitem', { name: /Temp/ }).count(), 0, 'excluded folder is not in the tree')
  assert.equal(await page.locator('.row-actions').count(), 0, 'actions live in the context menu')
  assert.ok((await page.locator('.write-age').count()) > 0, 'writes are captured and shown')
  assert.ok((await page.locator('.creation-age').count()) > 0, 'creation ages are captured and shown')
  await page.setViewportSize({ width: 2048, height: 900 })
  const columns = await page.getByRole('treeitem', { name: /A001\.mov/ }).evaluate((row) => {
    const cells = Array.from(row.children, (cell) => cell.getBoundingClientRect().width)
    return { cells, width: row.getBoundingClientRect().width }
  })
  assert.ok(columns.cells[0]! / columns.width < 0.4 && columns.cells[0]! / columns.width > 0.36)
  assert.ok(
    columns.cells.slice(1).every((width) => width < columns.cells[0]!),
    'name stays largest',
  )
  await page.screenshot({ path: join(shots, '2-space-wide.png') })
  await page.setViewportSize({ width: 1280, height: 820 })
  // Capture Explorer requests without opening a desktop window.
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { shownNode: { diskId: number; nodeId: number } | null }
    state.shownNode = null
    ipcMain.removeHandler('showNode')
    ipcMain.handle('showNode', (event, diskId: number, nodeId: number) => {
      state.shownNode = { diskId, nodeId }
      void event.sender.executeJavaScript('window.fixtureShown = true')
    })
  })
  const focusFile = page.getByRole('treeitem', { name: /A001\.mov/ })
  await focusFile.focus()
  await focusFile.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Show in Explorer' }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await focusFile.evaluate((row) => document.activeElement === row), true)
  await focusFile.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Show in Explorer' }).click()
  await page.waitForFunction(() => !!(window as unknown as { fixtureShown?: boolean }).fixtureShown)
  const shownNode = await app.evaluate(() => (globalThis as unknown as { shownNode: { nodeId: number } }).shownNode)
  const revealStore = new Store(openDb(join(userData, 'disk-watch-native.db')))
  assert.equal(revealStore.nodePath(shownNode.nodeId), join(root, 'Footage', 'day1', 'A001.mov'))
  revealStore.db.close()
  await focusFile.click({ button: 'right', position: { x: (await focusFile.boundingBox())!.width - 1, y: 1 } })
  const menuBounds = await page.getByRole('menu').boundingBox()
  assert.ok(menuBounds && menuBounds.x + menuBounds.width <= 1280 && menuBounds.y + menuBounds.height <= 820)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(shots, '2-space.png') })

  await page.getByRole('tab', { name: 'Treemap', exact: true }).click()
  const map = page.getByLabel('Disk usage treemap', { exact: true })
  await map.getByRole('button', { name: /^day1,/ }).waitFor()
  assert.equal(await map.getByRole('button', { name: /^Temp,/ }).count(), 0, 'map respects exclusions')
  await page.screenshot({ path: join(shots, '2-treemap.png') })
  await map.getByRole('button', { name: /^Footage,/ }).focus()
  await page.keyboard.press('Shift+F10')
  assert.equal(
    await page.getByRole('menuitem', { name: 'Queue for deletion' }).count(),
    0,
    'root children cannot be deleted from map',
  )
  await page.keyboard.press('Escape')
  await map.getByRole('button', { name: /^day1,/ }).click()
  await map.getByRole('button', { name: /^A001.mov,/ }).waitFor()
  const crumbs = page.getByRole('navigation', { name: 'Treemap location' })
  assert.equal(await crumbs.getByRole('button').count(), 3, 'nested clicks preserve parent breadcrumbs')
  await map.getByRole('button', { name: /^A001.mov,/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Queue for deletion' }).waitFor()
  await page.keyboard.press('Escape')
  await crumbs.getByRole('button').first().click()
  await map.getByRole('button', { name: /^Projects,/ }).click()
  await map.getByRole('button', { name: /^cache,/ }).click()
  await map.locator('.map-small-files').waitFor()
  assert.match(await map.innerText(), /Smaller files/)
  await page.screenshot({ path: join(shots, '2-treemap-small-files.png') })
  await page.getByRole('tab', { name: 'Space', exact: true }).click()

  write('Footage/day2/B001.mov', 60 * MB)
  write('Footage/day2/B002.mov', 45 * MB)
  write('Footage/day1/A003.mov', 5 * MB)
  write('Projects/cache/new-small.pek', 512 * 1024)
  rmSync(join(root, 'Downloads'), { recursive: true })
  await scan(page)

  // Replace just the owned app's comparison handler to exercise real IPC races.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers
    const original = handlers.get('compare')!
    const state = globalThis as unknown as { comparisonPlan: { delay: number; reject?: boolean }[] }
    state.comparisonPlan = []
    ipcMain.removeHandler('compare')
    ipcMain.handle('compare', async (...args: unknown[]) => {
      const plan = state.comparisonPlan.shift()
      if (plan) await new Promise((resolve) => setTimeout(resolve, plan.delay))
      if (plan?.reject) throw new Error('Fixture comparison failure')
      return original(...args)
    })
  })
  const plan = (items: { delay: number; reject?: boolean }[]) =>
    app.evaluate((_electron, items) => {
      ;(globalThis as unknown as { comparisonPlan: typeof items }).comparisonPlan = items
    }, items)
  const selected = async (name: string) =>
    assert.equal(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true')
  await plan([{ delay: 250, reject: true }])
  await page.getByRole('tab', { name: 'Changes' }).click()
  await selected('Space')
  assert.equal(await page.getByText('Where new data landed').count(), 0, 'no partial Changes page during rejected load')
  await page.getByRole('alert').filter({ hasText: 'Fixture comparison failure' }).waitFor()
  await selected('Space')
  await plan([{ delay: 400 }])
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await selected('Space')
  assert.equal(
    await page.getByText('Where new data landed').count(),
    0,
    'summary and tree prepare before Changes becomes selected',
  )
  await page.getByText('Where new data landed').waitFor()
  const grown = page.locator('.hotspots section').first().locator('li')
  await grown.first().waitFor()
  const hotspotItems = async () =>
    page
      .locator('.hotspots section')
      .first()
      .locator('li')
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            `${row.querySelector('.path')?.textContent?.trim() ?? ''}\n${row.querySelector('.num')?.textContent?.trim() ?? ''}`,
        ),
      )
  assert.deepEqual(await hotspotItems(), [
    'Footage\\day2\n+105 MB',
    'Footage\\day1\n+5.00 MB',
    'Projects\\cache\n+512 KB',
  ])
  for (const list of [page.locator('.hotspots section').nth(0), page.locator('.hotspots section').nth(1)]) {
    const item = list.locator('li').first()
    await item.focus()
    await item.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Show in Explorer' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await item.evaluate((row) => document.activeElement === row), true)
  }
  await page.getByRole('treeitem', { name: /Projects/ }).click()
  const changedCache = page.getByRole('treeitem', { name: /cache/ })
  await changedCache.click()
  assert.match(await changedCache.innerText(), /1\.14 MB\s+1\.64 MB\s+\+512 KB/)
  assert.equal(await page.getByRole('treeitem', { name: /smaller files/ }).count(), 0, 'Changes omits aggregate rows')
  assert.equal(await page.getByText('Nothing changed here', { exact: true }).count(), 0)
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).waitFor()
  assert.match(await page.getByRole('treeitem', { name: /Downloads/ }).innerText(), /gone/i)
  await page.screenshot({ path: join(shots, '3-changes.png') })

  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('button', { name: /^Scan \d/ }).click()
  await page.getByRole('option').nth(1).click()
  await page.getByRole('treeitem', { name: /Downloads/ }).waitFor()
  await page.getByRole('treeitem', { name: /Projects/ }).click()
  await page.getByRole('treeitem', { name: /cache/ }).click()
  assert.match(await page.getByRole('treeitem', { name: /cache/ }).innerText(), /1\.14 MB\s+300/)
  assert.equal(await page.getByRole('treeitem', { name: /smaller files/ }).count(), 0, 'old scans omit aggregate rows')
  await page.screenshot({ path: join(shots, '4-old-scan.png') })

  await page.getByRole('tab', { name: 'Treemap', exact: true }).click()
  await map.getByRole('button', { name: /^Downloads,/ }).waitFor()
  await page.getByRole('button', { name: /^Scan \d/ }).click()
  await page.getByRole('option').first().click()
  await map.getByRole('button', { name: /^day2,/ }).waitFor()
  assert.equal(await map.getByRole('button', { name: /^Downloads,/ }).count(), 0, 'scan selection updates map')
  await map.getByRole('button', { name: /^day2,/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Hide path', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  await map.getByRole('button', { name: /^day1,/ }).waitFor()
  assert.equal(await map.getByRole('button', { name: /^day2,/ }).count(), 0, 'hide immediately refreshes nested map')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await map.getByRole('button', { name: /^day2,/ }).waitFor()
  await page.setViewportSize({ width: 900, height: 650 })
  await map.getByRole('button', { name: /^day2,/ }).waitFor()
  await page.waitForFunction(() => {
    const view = document.querySelector('.treemap-view')!
    return view.scrollWidth <= view.clientWidth + 1
  })
  await page.screenshot({ path: join(shots, '4-treemap-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.screenshot({ path: join(shots, '4-treemap-latest.png') })
  await page.getByRole('tab', { name: 'Space', exact: true }).click()

  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByText(join(root, 'Temp')).waitFor()
  await page.screenshot({ path: join(shots, '5-settings.png') })
  // Return to Changes, hide via a hotspot, choose an ancestor, then edit the full path.
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.getByText('Where new data landed').waitFor()
  await page.locator('.hotspots .path').filter({ hasText: 'Footage\\day2' }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  const hide = page.getByRole('dialog')
  const fullPath = join(root, 'Footage', 'day2')
  assert.equal(await hide.getByLabel('Full path').inputValue(), fullPath)
  await hide.getByRole('button', { name: join(root, 'Footage'), exact: true }).click()
  assert.equal(await hide.getByLabel('Full path').inputValue(), join(root, 'Footage'))
  await hide.getByLabel('Full path').fill(fullPath.replaceAll('\\', '/'))
  await page.screenshot({ path: join(shots, '6-hide-dialog.png') })
  await hide.getByRole('button', { name: 'Hide path', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  assert.deepEqual(await hotspotItems(), ['Footage\\day1\n+5.00 MB', 'Projects\\cache\n+512 KB'])
  assert.equal(await page.locator('.hotspots .path').filter({ hasText: 'day2' }).count(), 0)
  assert.match(await page.locator('.view-bar .total').innerText(), /6.50 MB/)
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  assert.equal(await page.getByRole('treeitem', { name: /day2/ }).count(), 0)
  await page.getByRole('treeitem', { name: /Downloads/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  assert.equal(await page.getByRole('dialog').getByLabel('Full path').inputValue(), join(root, 'Downloads'))
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.screenshot({ path: join(shots, '7-hidden-changes.png') })

  // A selected comparison remains intact while a picker request is delayed/rejected.
  const oldTotal = await page.locator('.view-bar .total').innerText()
  await plan([{ delay: 400, reject: true }])
  await page.getByRole('button', { name: /^From / }).click()
  await page.getByRole('option').first().click()
  await selected('Changes')
  assert.equal(await page.locator('.view-bar .total').innerText(), oldTotal)
  await page.getByRole('alert').filter({ hasText: 'Fixture comparison failure' }).waitFor()
  assert.equal(await page.locator('.view-bar .total').innerText(), oldTotal)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByText('Pick two different scans').waitFor()
  await page.getByRole('button', { name: /^From / }).click()
  await page.getByRole('option').nth(1).click()
  await page.getByText('Where new data landed').waitFor()

  // Out-of-order picker results and navigation away cannot reveal a stale page.
  await plan([{ delay: 700 }, { delay: 150 }])
  await page.getByRole('button', { name: /^From / }).click()
  await page.getByRole('option').first().click()
  await page.getByText('Loading comparison').waitFor()
  await page.waitForTimeout(80)
  await page.getByRole('button', { name: /^To / }).click()
  await page.getByRole('option').nth(1).click()
  await page.getByText(/Loading (view|comparison)/).waitFor({ state: 'hidden' })
  await page.waitForTimeout(750)
  assert.equal(await page.getByText('Pick two different scans').count(), 0)
  assert.equal(
    await page.locator('.view-bar .total').innerText(),
    oldTotal,
    'latest picker intent retains both requested fields',
  )
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).waitFor()
  await plan([{ delay: 500 }])
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.waitForTimeout(80)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByText('Hidden from views', { exact: true }).waitFor()
  await page.waitForTimeout(600)
  await selected('Settings')
  assert.equal(await page.getByText('Where new data landed').count(), 0)

  // Edit/remove and Undo use the persisted per-disk rule revision.
  const rule = page.locator('.hidden-paths li').filter({ hasText: fullPath })
  await rule.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByLabel('Full path')
    .fill(join(root, 'Footage', 'day1'))
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await page
    .locator('.hidden-paths')
    .getByText(join(root, 'Footage', 'day1'), { exact: true })
    .waitFor()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.locator('.hidden-paths').getByText(fullPath, { exact: true }).waitFor()
  await page.locator('.hidden-paths li').getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  assert.equal(await page.locator('.hidden-paths li').count(), 0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.locator('.hidden-paths').getByText(fullPath, { exact: true }).waitFor()
  await page.getByLabel('Hide NTFS metadata at the drive root').uncheck()
  await page.getByText('Metadata visibility updated.').waitFor()
  await page.screenshot({ path: join(shots, '8-hidden-settings.png') })

  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers
    const original = handlers.get('openDisk')!
    const delays = [500, 100]
    ipcMain.removeHandler('openDisk')
    ipcMain.handle('openDisk', async (...args: unknown[]) => {
      const delay = delays.shift()
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      return original(...args)
    })
  })
  await page.locator('.disk').filter({ hasText: second }).click()
  await page.getByText('Loading view').waitFor()
  await page.locator('.disk').filter({ hasText: root }).click()
  await page.getByText(/Loading (view|comparison)/).waitFor({ state: 'hidden' })
  await page.waitForTimeout(600)
  assert.equal(
    await page.locator('.disk-header h2').innerText(),
    root,
    'late disk load cannot replace latest selection',
  )
  await page.locator('.hidden-paths').getByText(fullPath, { exact: true }).waitFor()
  await page.locator('.disk').filter({ hasText: second }).click()
  await page.locator('.disk-header h2').getByText(second, { exact: true }).waitFor()
  assert.equal(await page.locator('.hidden-paths li').count(), 0, 'hide rules belong to one disk')
  await page.locator('.disk').filter({ hasText: root }).click()
  await page.locator('.hidden-paths').getByText(fullPath, { exact: true }).waitFor()

  await app.close()
  // Synthetic MFT evidence lives only in this temporary DB; no scan of Q: runs.
  const metadata = new Store(openDb(join(userData, 'disk-watch-native.db')))
  const metaDisk = metadata.addDisk('Q:\\')
  const metaNode = (parent: number, name: string, kind: string) =>
    Number(
      metadata.db.prepare('INSERT INTO node(parent,name,kind) VALUES(?,?,?)').run(parent, name, kind).lastInsertRowid,
    )
  const mft = metaNode(metaDisk.rootNode, '$MFT', 'file')
  const extend = metaNode(metaDisk.rootNode, '$Extend', 'dir')
  const journal = metaNode(extend, '$UsnJrnl', 'file')
  const svi = metaNode(metaDisk.rootNode, 'System Volume Information', 'dir')
  const metaScan = metadata.beginScan(metaDisk.id, [])
  metadata.db
    .prepare("UPDATE scan SET status='complete',method='mft',size=?,files=3,dirs=3 WHERE id=?")
    .run(16 * MB, metaScan)
  for (const [id, size, files] of [
    [metaDisk.rootNode, 16 * MB, 3],
    [mft, 8 * MB, 1],
    [extend, 6 * MB, 1],
    [journal, 6 * MB, 1],
    [svi, 2 * MB, 1],
  ])
    metadata.db
      .prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,?,?)')
      .run(metaScan, id!, size!, files!)
  metadata.db.close()
  const nestedRoot = join(root, 'Footage')
  const nestedFixture = new Store(openDb(join(userData, 'disk-watch-native.db')))
  const nestedDisk = nestedFixture.addDisk(nestedRoot)
  const nestedDay = Number(
    nestedFixture.db.prepare("INSERT INTO node(parent,name,kind) VALUES(?,'day1','dir')").run(nestedDisk.rootNode)
      .lastInsertRowid,
  )
  const nestedFile = Number(
    nestedFixture.db.prepare("INSERT INTO node(parent,name,kind) VALUES(?,'A001.mov','file')").run(nestedDay)
      .lastInsertRowid,
  )
  const nestedScan = nestedFixture.beginScan(nestedDisk.id, [])
  nestedFixture.db
    .prepare("UPDATE scan SET status='complete',method='walk',size=?,files=1,dirs=2 WHERE id=?")
    .run(40 * MB, nestedScan)
  for (const id of [nestedDisk.rootNode, nestedDay, nestedFile])
    nestedFixture.db
      .prepare('INSERT INTO entry(scan_id,node_id,size,files) VALUES(?,?,?,1)')
      .run(nestedScan, id, 40 * MB)
  nestedFixture.db.close()
  app = await electron.launch({
    executablePath: join(import.meta.dirname, '../node_modules/electron/dist/electron.exe'),
    args: [join(import.meta.dirname, '..'), `--user-data-dir=${userData}`],
    env: { ...env, DISK_WATCH_VERIFY: '1' },
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.getByRole('treeitem', { name: /Footage/ }).waitFor()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  assert.equal(await page.getByRole('treeitem', { name: /day2/ }).count(), 0, 'hide persists after reopening')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.locator('.hidden-paths').getByText(fullPath, { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Hide NTFS metadata at the drive root').isChecked(), false)
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('button', { name: /^Scan \d/ }).click()
  await page.getByRole('option').nth(1).click()
  await page.getByRole('treeitem', { name: /Footage/ }).waitFor()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).waitFor()
  assert.equal(await page.getByRole('treeitem', { name: /day2/ }).count(), 0)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.locator('.hidden-paths li').getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.locator('.hotspots .path').filter({ hasText: 'Footage\\day2' }).first().waitFor()
  await page.screenshot({ path: join(shots, '9-restored.png') })
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await page.getByRole('treeitem', { name: /A001\.mov/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Hide path', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  assert.equal(
    await page.getByRole('treeitem', { name: /A001\.mov/ }).count(),
    0,
    'right-clicking a real file immediately filters its Space row',
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await page.getByRole('treeitem', { name: /A001\.mov/ }).waitFor()
  await page.locator('.disk').filter({ hasText: 'Q:\\' }).click()
  await page.getByRole('treeitem', { name: /System Volume Information/ }).waitFor()
  assert.equal(await page.getByRole('treeitem', { name: /\$MFT|\$Extend/ }).count(), 0)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByText('Applies to known NTFS metadata files').waitFor()
  await page.getByLabel('Hide NTFS metadata at the drive root').uncheck()
  await page.getByText('Metadata visibility updated.').waitFor()
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /\$MFT/ }).waitFor()
  await page.getByRole('treeitem', { name: /\$Extend/ }).click()
  await page.getByRole('treeitem', { name: /\$UsnJrnl/ }).waitFor()
  await page.screenshot({ path: join(shots, '10-metadata-restored.png') })

  // A delayed lookup from the nested disk must not open against its parent disk.
  const diskButton = (path: string) => page.locator('.disk').filter({ has: page.getByText(path, { exact: true }) })
  await diskButton(nestedRoot).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await page.getByRole('treeitem', { name: /A001\.mov/ }).waitFor()
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers
    const state = globalThis as unknown as {
      hideLookups: number
      hideDelays: number[]
      diskDelays: number[]
      excludeDelays: number[]
      excludeLookups: number
    }
    state.hideLookups = 0
    state.excludeLookups = 0
    state.excludeDelays = []
    state.hideDelays = [350]
    state.diskDelays = [900]
    for (const channel of ['nodeLocation', 'openDisk', 'addExcludeNode']) {
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args: unknown[]) => {
        if (channel === 'nodeLocation') ++state.hideLookups
        if (channel === 'addExcludeNode') ++state.excludeLookups
        const delay = (
          channel === 'nodeLocation'
            ? state.hideDelays
            : channel === 'addExcludeNode'
              ? state.excludeDelays
              : state.diskDelays
        ).shift()
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        return original(...args)
      })
    }
  })
  await page.getByRole('treeitem', { name: /A001\.mov/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  assert.equal(await app.evaluate(() => (globalThis as unknown as { hideLookups: number }).hideLookups), 1)
  await diskButton(root).click()
  await page.getByText('Loading view').waitFor()
  await page.waitForTimeout(500)
  assert.equal(await page.getByRole('dialog').count(), 0, 'stale lookup is discarded while another disk is pending')
  await page.locator('.disk-header h2').getByText(root, { exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0, 'stale lookup cannot leave a dialog on the new disk')
  const parentSnapshot = await page.evaluate(() => window.diskWatch.listDisks())
  const parentDiskId = parentSnapshot.find((disk) => disk.root === root)!.id
  const hiddenPaths = async () =>
    (
      await page.evaluate(
        (ids) => Promise.all(ids.map((id) => window.diskWatch.openDisk(id))),
        [nestedDisk.id, parentDiskId],
      )
    ).map((snapshot) => snapshot.disk.hides.paths)
  assert.deepEqual(await hiddenPaths(), [[], []], 'no stale hide is persisted to either nested root')
  await page.screenshot({ path: join(shots, '11-hide-navigation-race.png') })

  // A completed old lookup must also leave a newer context action intact.
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await app.evaluate(() => {
    ;(globalThis as unknown as { hideDelays: number[] }).hideDelays = [350]
  })
  await page.getByRole('treeitem', { name: /A001\.mov/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  await page.getByRole('treeitem', { name: /A002\.mov/ }).click({ button: 'right' })
  await page.waitForTimeout(450)
  assert.equal(await page.getByRole('dialog').count(), 0, 'new context action supersedes old path lookup')
  await page.getByRole('menuitem', { name: 'Hide…' }).click()
  assert.equal(
    await page.getByRole('dialog').getByLabel('Full path').inputValue(),
    join(root, 'Footage', 'day1', 'A002.mov'),
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Hide path', exact: true }).click()
  await page.getByText('Hidden paths updated.').waitFor()
  assert.deepEqual(
    await hiddenPaths(),
    [[], [join(root, 'Footage', 'day1', 'A002.mov')]],
    'saving the current dialog changes only its captured disk',
  )

  // A real file can be excluded from Changes or Space; Settings exposes separate native pickers.
  const fileToExclude = join(root, 'Footage', 'day2', 'B001.mov')
  const exclusion = (path: string) =>
    page
      .locator('.settings section')
      .filter({ has: page.getByRole('heading', { name: 'Excluded files and folders', exact: true }) })
      .locator('li')
      .filter({ hasText: path })
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).click()
  await page.getByRole('treeitem', { name: /B001\.mov/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Exclude', exact: true }).click()
  await page.getByText(`${fileToExclude} is excluded.`).waitFor()
  assert.match(
    await page.locator('.hotspots section').first().locator('li').filter({ hasText: 'Footage\\day2' }).innerText(),
    /\+45\.0 MB/,
  )
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).click()
  assert.equal(await page.getByRole('treeitem', { name: /B001\.mov/ }).count(), 0)
  await page.getByRole('treeitem', { name: /B002\.mov/ }).waitFor()
  await page.getByRole('tab', { name: 'Settings' }).click()
  await exclusion(fileToExclude).getByRole('button', { name: 'Remove', exact: true }).click()

  // Stub only the native picker, so this drives the real Settings -> IPC -> Store path without desktop dialogs.
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      pickerResult: string | null
      pickerOptions: { title?: string; properties?: string[] }[]
    }
    state.pickerResult = null
    state.pickerOptions = []
    dialog.showOpenDialog = (async (_window: unknown, options: { title?: string; properties?: string[] }) => {
      state.pickerOptions.push(options)
      return { canceled: !state.pickerResult, filePaths: state.pickerResult ? [state.pickerResult] : [] }
    }) as typeof dialog.showOpenDialog
  })
  await page.getByRole('button', { name: 'Add excluded folder…' }).click()
  await page.getByRole('button', { name: 'Add excluded file…' }).waitFor({ state: 'visible' })
  await app.evaluate((_electron, path) => {
    ;(globalThis as unknown as { pickerResult: string }).pickerResult = path
  }, fileToExclude)
  await page.getByRole('button', { name: 'Add excluded file…' }).click()
  await exclusion(fileToExclude).waitFor()
  const pickerOptions = await app.evaluate(
    () => (globalThis as unknown as { pickerOptions: { title?: string; properties?: string[] }[] }).pickerOptions,
  )
  assert.deepEqual(
    pickerOptions.map((options) => options.properties),
    [
      ['openDirectory', 'showHiddenFiles'],
      ['openFile', 'showHiddenFiles'],
    ],
  )
  await page.screenshot({ path: join(shots, '14-file-exclusions.png') })
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).click()
  assert.equal(
    await page.getByRole('treeitem', { name: /B001\.mov/ }).count(),
    0,
    'file picker exclusion filters Space',
  )
  await page.getByRole('tab', { name: 'Settings' }).click()
  await exclusion(fileToExclude).getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).click()
  const fileRow = page.getByRole('treeitem', { name: /B001\.mov/ })
  await fileRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Exclude', exact: true }).click()
  await page.getByText(`${fileToExclude} is excluded.`).waitFor()
  await page.getByRole('tab', { name: 'Settings' }).click()
  await exclusion(fileToExclude).getByRole('button', { name: 'Remove', exact: true }).click()

  // Exclude recalculates the bottom tree and top Changes list immediately. Settings restores it.
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.getByText('Where new data landed').waitFor()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  const day2Row = page.getByRole('treeitem', { name: /day2/ })
  await day2Row.waitFor()
  await day2Row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Exclude', exact: true }).click()
  await page.getByText(`${join(root, 'Footage', 'day2')} is excluded.`).waitFor()
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).waitFor()
  assert.equal(
    await page.getByRole('treeitem', { name: /day2/ }).count(),
    0,
    'Exclude removes folder from tree immediately',
  )
  assert.equal(
    await page.locator('.hotspots .path').filter({ hasText: 'day2' }).count(),
    0,
    'Exclude recalculates top hotspots immediately',
  )
  assert.equal(
    await page.getByRole('button', { name: 'Undo', exact: true }).count(),
    0,
    'Exclude does not expose an unsafe whole-settings Undo',
  )
  await page.getByRole('tab', { name: 'Settings' }).click()
  const excludedRow = page
    .locator('.settings section')
    .filter({ has: page.getByRole('heading', { name: 'Excluded files and folders', exact: true }) })
    .locator('li')
    .filter({ hasText: join(root, 'Footage', 'day2') })
  await excludedRow.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.locator('.hotspots .path').filter({ hasText: 'Footage\\day2' }).first().waitFor()

  // Row Exclude resolves its initiating disk even while another disk is loading.
  await diskButton(nestedRoot).click()
  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('treeitem', { name: /day1/ }).waitFor()
  await app.evaluate(() => {
    const state = globalThis as unknown as { excludeDelays: number[]; excludeLookups: number; diskDelays: number[] }
    state.excludeLookups = 0
    state.excludeDelays = [350]
    state.diskDelays = [900]
  })
  const nestedDayRow = page.getByRole('treeitem', { name: /day1/ })
  await nestedDayRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Exclude', exact: true }).click()
  await diskButton(root).click()
  await page.getByText(`${join(nestedRoot, 'day1')} is excluded.`).waitFor()
  assert.equal(
    await app.evaluate(() => (globalThis as unknown as { excludeLookups: number }).excludeLookups),
    1,
    'the delayed exclusion used its actual node IPC',
  )
  const excludedSnapshots = await page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.diskWatch.openDisk(id))),
    [nestedDisk.id, parentDiskId],
  )
  assert.ok(excludedSnapshots[0]!.disk.excludes.includes(join(nestedRoot, 'day1')))
  assert.equal(
    excludedSnapshots[1]!.disk.excludes.includes(join(nestedRoot, 'day1')),
    false,
    'delayed Exclude stays with initiating disk',
  )
  await page.evaluate((id) => window.diskWatch.setExcludes(id, []), nestedDisk.id)
  await page.getByText(/Loading (view|comparison)/).waitFor({ state: 'hidden' })

  // Top-level items cannot be queued. Pending staging is cancelled by Clear/navigation.
  await page.getByRole('tab', { name: 'Space' }).click()
  const footageTop = page.getByRole('treeitem', { name: /Footage/ })
  await footageTop.waitFor()
  await footageTop.click({ button: 'right' })
  assert.equal(await page.getByRole('menuitem', { name: 'Queue for deletion', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  const expand = async (name: RegExp) => {
    const row = page.getByRole('treeitem', { name })
    await row.waitFor()
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
    return row
  }
  const queue = async (name: RegExp) => {
    const row = page.getByRole('treeitem', { name })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Queue for deletion', exact: true }).click()
  }
  await expand(/Footage/)
  await queue(/day2/)
  const summary = page.getByRole('region', { name: 'Staged deletions' })
  await summary.waitFor()
  await expand(/day2/)
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers
    const original = handlers.get('stageDelete')!
    const state = globalThis as unknown as { stageDelays: number[] }
    state.stageDelays = []
    ipcMain.removeHandler('stageDelete')
    ipcMain.handle('stageDelete', async (...args: unknown[]) => {
      const delay = state.stageDelays.shift()
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      return original(...args)
    })
  })
  const delayStage = () =>
    app.evaluate(() => {
      ;(globalThis as unknown as { stageDelays: number[] }).stageDelays = [400]
    })
  await delayStage()
  await queue(/B001\.mov/)
  await summary.getByRole('button', { name: 'Clear', exact: true }).click()
  await page.waitForTimeout(500)
  assert.equal(await summary.count(), 0, 'Clear cancels an outstanding stage response')
  await delayStage()
  await queue(/B002\.mov/)
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByText('Hidden from views', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  assert.equal(await summary.count(), 0, 'navigation cancels pending staging')
  await page.getByRole('tab', { name: 'Space' }).click()
  await expand(/Footage/)
  await expand(/day2/)
  await queue(/B001\.mov/)
  await summary.waitFor()
  assert.match(await summary.innerText(), /60.0 MB estimated/)
  await queue(/day2/)
  await page.getByRole('treeitem', { name: /day2/ }).locator('.tag.staged').waitFor()
  assert.match(await summary.innerText(), /1 item staged for deletion/)
  assert.match(await summary.innerText(), /105 MB estimated/)
  await summary.getByRole('button', { name: 'Review', exact: true }).click()
  assert.equal(await summary.locator('li').count(), 1, 'parent and child paths count once')
  await expand(/day1/)
  await queue(/A001\.mov/)
  const queuedFile = page.getByRole('treeitem', { name: /A001\.mov/ })
  await queuedFile.locator('.tag.staged').waitFor()
  await queuedFile.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from delete queue', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.match(await summary.innerText(), /2 items staged for deletion/)
  assert.match(await summary.innerText(), /145 MB estimated/)
  await page.screenshot({ path: join(shots, '12-staged-delete.png') })

  // Replace a staged file with a directory. It must fail without recursively deleting it.
  const replaced = join(root, 'Footage', 'day1', 'A001.mov')
  rmSync(replaced)
  mkdirSync(replaced)
  writeFileSync(join(replaced, 'keep.txt'), 'new folder remains')
  // Only owned fixture roots remain if a missing lock ever lets the test scan start.
  await page.evaluate((id) => window.diskWatch.removeDisk(id), metaDisk.id)
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
      ._invokeHandlers
    const original = handlers.get('executeDelete')!
    ipcMain.removeHandler('executeDelete')
    ipcMain.handle('executeDelete', async (...args: unknown[]) => {
      const operation = Promise.resolve(original(...args))
      const blockedByActiveOperation = (error: unknown) =>
        String(error).includes('Wait for the current filesystem operation to finish.')
      const scanBlocked = Promise.resolve()
        .then(() => handlers.get('startScan')!({}))
        .then(() => false, blockedByActiveOperation)
      const concurrentBlocked = Promise.resolve()
        .then(() => original(...args))
        .then(() => false, blockedByActiveOperation)
      const result = await operation
      ;(globalThis as unknown as { deleteLocks: { scan: boolean; concurrent: boolean } }).deleteLocks = {
        scan: await scanBlocked,
        concurrent: await concurrentBlocked,
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
      return result
    })
  })
  await summary.getByRole('button', { name: 'Execute delete', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Scan all drives', exact: true }).isDisabled(), true)
  await diskButton(second).click()
  await page.locator('.disk-header h2').getByText(second, { exact: true }).waitFor()
  const failureDialog = page.getByRole('dialog', { name: 'Some paths could not be deleted' })
  await failureDialog.waitFor()
  assert.match(await failureDialog.innerText(), /type changed/)
  await failureDialog.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(existsSync(join(root, 'Footage', 'day2')), false, 'successful queued folder is deleted')
  assert.equal(existsSync(join(replaced, 'keep.txt')), true, 'file-to-folder replacement remains untouched')
  assert.equal(await summary.count(), 0, 'completion does not move the old queue onto the selected disk')
  assert.deepEqual(await app.evaluate(() => (globalThis as unknown as { deleteLocks: unknown }).deleteLocks), {
    scan: true,
    concurrent: true,
  })
  await diskButton(root).click()
  await summary.waitFor()
  assert.match(await summary.innerText(), /1 item staged for deletion/)
  assert.match(await summary.innerText(), /40.0 MB estimated/)
  await summary.getByRole('button', { name: /Review|Hide list/ }).click()
  if ((await summary.locator('li').count()) === 0)
    await summary.getByRole('button', { name: 'Review', exact: true }).click()
  assert.deepEqual(
    await summary.locator('li .path').allTextContents(),
    [replaced],
    'failed target stays queued and successes are removed',
  )
  await expand(/Footage/)
  await page.getByRole('treeitem', { name: /day2/ }).waitFor()
  assert.equal(
    await page.getByRole('treeitem', { name: /day2/ }).count(),
    1,
    'captured tree remains intact after deletion',
  )
  await page.screenshot({ path: join(shots, '13-partial-delete.png') })

  // Real lock-owner detection and copying, including a path wider than the popup.
  const longFolder = join(
    'Projects',
    'exports',
    'session-' + 'render-output-'.repeat(6),
    'camera-' + 'footage-'.repeat(4),
  )
  const longFile = join(longFolder, 'locked-å-日本語.mov')
  write(longFile, 2 * MB)
  write(join(longFolder, 'good.mov'), MB)
  await scan(page)
  await summary.getByRole('button', { name: 'Clear', exact: true }).click()
  await expand(/Projects/)
  await expand(/exports/)
  await expand(/session-render/)
  const camera = page.getByRole('treeitem', { name: /camera-footage/ })
  await camera.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Queue for deletion', exact: true }).click()
  const lockedPath = join(root, longFile)
  const before = await page.evaluate(async () => (await window.diskWatch.listDisks()).map((disk) => disk.latestScan))
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    const snapshot = async () => {
      const items = await clipboard.read()
      return Promise.all(
        items
          .filter((item) => item.types.length > 0)
          .map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))),
              ),
          ),
      )
    }
    const saved = await snapshot()
    ;(globalThis as unknown as { fixtureClipboard: Electron.ClipboardItem[] }).fixtureClipboard = saved
    try {
      clipboard.clear()
      if ((await snapshot()).length !== 0) throw new Error('Empty clipboard snapshot should contain no entries.')
    } finally {
      if (saved.length) await clipboard.write(saved)
      else clipboard.clear()
    }
  })
  const lock = await holdFile(lockedPath)
  try {
    await summary.getByRole('button', { name: 'Execute delete', exact: true }).click()
    await failureDialog.waitFor()
    assert.match(await failureDialog.innerText(), /powershell\.exe/i)
    assert.match(await failureDialog.innerText(), new RegExp(String(lock.pid)))
    assert.match(await failureDialog.innerText(), /Program name/)
    const failedPath = failureDialog
      .locator('.failure-field')
      .filter({ hasText: 'Failed operation path' })
      .locator('dd')
    assert.equal(await failedPath.innerText(), lockedPath)
    assert.equal(await failedPath.evaluate((element) => getComputedStyle(element).userSelect), 'text')
    await failureDialog.getByRole('button', { name: 'Copy process id', exact: true }).click()
    await failureDialog.getByRole('status').getByText('Process ID copied.', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), String(lock.pid))
    await failureDialog.getByRole('button', { name: 'Copy failed operation path', exact: true }).click()
    await failureDialog.getByRole('status').getByText('Failed operation path copied.', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), lockedPath)
    await failureDialog.getByRole('button', { name: 'Copy report', exact: true }).click()
    await failureDialog.getByRole('status').getByText('Report copied.', { exact: true }).waitFor()
    const report = await app.evaluate(({ clipboard }) => clipboard.readText())
    assert.ok(report.includes(`Process ID: ${lock.pid}`) && report.includes(lockedPath))
    assert.ok(report.includes('One failed operation is shown per queued path.'))
    const bounds = await failureDialog.boundingBox()
    assert.ok(bounds && bounds.width >= 1000 && bounds.height <= 820 * 0.9 + 2)
    assert.equal(await failureDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    await page.screenshot({ path: join(shots, '14-lock-owner-popup.png') })
    await page.keyboard.press('Escape')
    await failureDialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'View details', exact: true }).click()
    await failureDialog.waitFor()
    await page.setViewportSize({ width: 760, height: 600 })
    assert.equal(await failureDialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    await page.screenshot({ path: join(shots, '15-lock-owner-small-window.png') })
    await failureDialog.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(
      await page
        .getByRole('button', { name: 'View details', exact: true })
        .evaluate((element) => document.activeElement === element),
      true,
    )
    assert.equal(existsSync(join(root, longFolder, 'good.mov')), false)
    assert.equal(existsSync(lockedPath), true)
    assert.deepEqual(
      await page.evaluate(async () => (await window.diskWatch.listDisks()).map((disk) => disk.latestScan)),
      before,
    )
  } finally {
    await lock.release()
    await app.evaluate(async ({ clipboard }) => {
      const saved = (globalThis as unknown as { fixtureClipboard: Electron.ClipboardItem[] }).fixtureClipboard
      if (saved.length) await clipboard.write(saved)
      else clipboard.clear()
    })
  }
  await page.setViewportSize({ width: 1280, height: 820 })
  await summary.getByRole('button', { name: 'Execute delete', exact: true }).click()
  await page.getByText(/Removed 1 queued path\./).waitFor()
  assert.equal(existsSync(join(root, longFolder)), false, 'retry works after the owner releases its handle')

  // Multiple failures, unavailable metadata and a clipboard rejection stay readable.
  await queue(/edit\.prproj/)
  await queue(/cache/)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('executeDelete')
    ipcMain.handle('executeDelete', (_event, _disk, targets: { path: string }[]) => ({
      deleted: [],
      failed: targets.map((target, index) => ({
        path: target.path,
        failedPath: target.path,
        message: 'Access denied.',
        errorCode: 5,
        lockInfo:
          index === 0
            ? {
                status: 'found',
                note: 'Fixture lookup snapshot with protected metadata.',
                processes: [
                  {
                    pid: 4242,
                    programName: null,
                    processName: null,
                    executablePath: null,
                    serviceName: 'FixtureService',
                    source: 'open_handle',
                    note: 'Executable details are unavailable.',
                  },
                ],
              }
            : { status: 'unavailable', processes: [], note: 'This file system does not support owner lookup.' },
      })),
    }))
    ipcMain.removeHandler('copyText')
    ipcMain.handle('copyText', () => {
      throw new Error('Fixture clipboard rejection.')
    })
  })
  await summary.getByRole('button', { name: 'Execute delete', exact: true }).click()
  await failureDialog.waitFor()
  assert.equal(await failureDialog.getByRole('region', { name: /Failed path/ }).count(), 2)
  assert.equal(await failureDialog.getByRole('button', { name: 'Copy executable path', exact: true }).count(), 0)
  await failureDialog.getByRole('button', { name: 'Copy process id', exact: true }).click()
  await failureDialog
    .getByRole('status')
    .getByText('Could not copy. Select the value and press Ctrl+C.', { exact: true })
    .waitFor()
  assert.match(await failureDialog.innerText(), /Windows could not identify/)
  assert.match(await failureDialog.innerText(), /FixtureService/)
  await page.screenshot({ path: join(shots, '16-lock-owner-unavailable.png') })
  await failureDialog.getByRole('button', { name: 'Close', exact: true }).click()
  console.log(`ok, screenshots in ${shots}`)
} catch (error) {
  const failedPage = await app.firstWindow()
  console.error((await failedPage.locator('main').innerText()).slice(0, 4000))
  await failedPage.screenshot({ path: join(shots, 'failure.png') })
  throw error
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  rmSync(second, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
