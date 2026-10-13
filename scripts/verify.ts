// Drives the built app end to end against a temp folder and saves screenshots.
// Usage: npm run build && node scripts/verify.ts [screenshot dir]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { openDb, Store } from '../src/main/store.ts'

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

const store = new Store(openDb(join(userData, 'disk-watch.db')))
store.setExcludes(store.addDisk(root).id, [join(root, 'Temp')])
store.addDisk(second)
store.db.close()

// Set when this runs from inside another Electron app; it would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
const app = await electron.launch({
  executablePath: join(import.meta.dirname, '../node_modules/electron/dist/electron.exe'),
  args: [join(import.meta.dirname, '..'), `--user-data-dir=${userData}`],
  env,
})
try {
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('pageerror', err))
  await page.setViewportSize({ width: 1280, height: 820 })

  async function scan(page: Page) {
    await page.getByRole('button', { name: 'Scan all drives' }).click()
    await page.getByRole('button', { name: 'Scan all drives' }).waitFor({ timeout: 60_000 })
  }

  await page.getByText('No scans yet').waitFor()
  await page.screenshot({ path: join(shots, '1-empty.png') })
  await scan(page)
  await page
    .getByText(/scanned \d/)
    .nth(1)
    .waitFor({ timeout: 5000 })
  assert.equal(await page.getByText('never scanned').count(), 0, 'one click scans every tracked folder')

  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day1/ }).click()
  await page.getByRole('treeitem', { name: /A001\.mov/ }).waitFor()
  await page.getByRole('treeitem', { name: /Projects/ }).click()
  await page.getByRole('treeitem', { name: /cache/ }).click()
  await page.getByRole('treeitem', { name: /300 smaller files/ }).waitFor()
  assert.equal(await page.getByRole('treeitem', { name: /Temp/ }).count(), 0, 'excluded folder is not in the tree')
  await page.screenshot({ path: join(shots, '2-space.png') })

  write('Footage/day2/B001.mov', 60 * MB)
  write('Footage/day2/B002.mov', 45 * MB)
  write('Footage/day1/A003.mov', 5 * MB)
  rmSync(join(root, 'Downloads'), { recursive: true })
  await scan(page)

  await page.getByRole('tab', { name: 'Changes' }).click()
  await page.getByText('Where new data landed').waitFor()
  const grown = page.locator('.hotspots section').first().locator('li')
  await grown.first().waitFor()
  assert.deepEqual(await grown.allInnerTexts(), ['Footage\\day2\n+105 MB', 'Footage\\day1\n+5.00 MB'])
  await page.getByRole('treeitem', { name: /Footage/ }).click()
  await page.getByRole('treeitem', { name: /day2/ }).waitFor()
  assert.match(await page.getByRole('treeitem', { name: /Downloads/ }).innerText(), /gone/i)
  await page.screenshot({ path: join(shots, '3-changes.png') })

  await page.getByRole('tab', { name: 'Space' }).click()
  await page.getByRole('button', { name: /^Scan \d/ }).click()
  await page.getByRole('option').nth(1).click()
  await page.getByRole('treeitem', { name: /Downloads/ }).waitFor()
  await page.screenshot({ path: join(shots, '4-old-scan.png') })

  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByText(join(root, 'Temp')).waitFor()
  await page.screenshot({ path: join(shots, '5-settings.png') })
  console.log(`ok, screenshots in ${shots}`)
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
