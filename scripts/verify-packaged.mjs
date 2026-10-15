import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { openDb, Store } from '../src/main/store.ts'

const executable = resolve(process.argv[2] ?? 'dist/win-unpacked/Disk Watch.exe')
assert.ok(existsSync(executable), `Build the Windows executable first: ${executable}`)
const fixture = mkdtempSync(join(tmpdir(), 'dw-packaged-'))
const userData = join(fixture, 'user-data')
const root = join(fixture, 'files')
mkdirSync(userData)
mkdirSync(root)
writeFileSync(join(root, 'video.mov'), Buffer.alloc(2 * 1024 * 1024))
const store = new Store(openDb(join(userData, 'disk-watch-native.db')))
store.addDisk(root)
store.db.close()

const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
const app = await electron.launch({
  executablePath: executable,
  args: [`--user-data-dir=${userData}`],
  env: { ...env, DISK_WATCH_VERIFY: '1' },
})
try {
  const page = await app.firstWindow()
  const identity = await app.evaluate(({ app, BrowserWindow, nativeImage }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const resources = process.resourcesPath
    return {
      name: app.getName(),
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      title: BrowserWindow.getAllWindows()[0].getTitle(),
      visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      scanner: fs.existsSync(path.join(resources, 'dw-scan.exe')),
      icon: !nativeImage.createFromPath(path.join(resources, 'icon.ico')).isEmpty(),
      archive: fs.readdirSync(path.join(resources, 'app.asar')).sort(),
    }
  })
  assert.equal(identity.name, 'Disk Watch')
  assert.equal(identity.title, 'Disk Watch')
  assert.equal(identity.packaged, true)
  assert.equal(identity.userData, userData)
  assert.equal(identity.visible, false)
  assert.equal(identity.scanner, true)
  assert.equal(identity.icon, true)
  assert.deepEqual(identity.archive, ['out', 'package.json'])
  await page.getByText('No scans yet').waitFor()
  await page.getByRole('button', { name: 'Scan all drives', exact: true }).click()
  await page.getByRole('treeitem', { name: /video\.mov/ }).waitFor({ timeout: 30_000 })
  const scan = await page.evaluate(async () => {
    const [disk] = await window.diskWatch.listDisks()
    return disk.latestScan
  })
  assert.equal(scan.status, 'complete')
  assert.equal(scan.method, 'walk')
  assert.equal(scan.size, 2 * 1024 * 1024)
  assert.equal(scan.files, 1)
  assert.equal(await page.locator('.write-age').count(), 1)
  assert.equal(await page.locator('.creation-age').count(), 1)
  assert.equal(await page.locator('.row-actions').count(), 0)
  const row = page.getByRole('treeitem', { name: /video\.mov/ })
  await row.focus()
  await row.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Show in Explorer' }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await row.evaluate((element) => document.activeElement === element), true)
  await page.getByRole('tab', { name: 'Treemap', exact: true }).click()
  await page
    .getByLabel('Disk usage treemap', { exact: true })
    .getByRole('button', { name: /^video\.mov,/ })
    .waitFor()
  await page.screenshot({ path: join(fixture, 'packaged.png') })
  console.log(
    `ok: packaged startup, icon, isolated user data, bundled scanner, worker scan and treemap; screenshot ${join(fixture, 'packaged.png')}`,
  )
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}
