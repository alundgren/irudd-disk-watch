import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vite-plus/test'
import type { Disk } from '../../shared/types'
import { DELETE_SCAN_MAX_AGE_MS } from '../../shared/scanFreshness'

vi.stubGlobal('window', { diskWatch: {} })
const { RootScanRow, ScanPanel } = await import('./App')
const { cleanupScanProblem } = await import('./api')
const disk: Disk = {
  id: 1,
  root: '/fixture',
  rootNode: 1,
  excludes: [],
  capacity: null,
  latestScan: null,
  machine: { id: 'fixture', kind: 'local', os: 'macos', name: 'Fixture Mac' },
  scanIncluded: true,
  nativeRoot: {
    path: '/fixture',
    pathBytes: 'L2ZpeHR1cmU=',
    identity: { device: '1', inode: '2' },
    filesystem: 'apfs',
    capacity: null,
    observedAt: 1,
    readOnly: false,
  },
  hides: { paths: [], metadata: false, metadataEligible: false, revision: 0 },
}
const noop = () => {}

test('root navigation and the persistent scan checkbox are separate controls', () => {
  const row = (item: Disk) =>
    renderToStaticMarkup(
      <RootScanRow disk={item} selected scanning={false} disabled={false} onNavigate={noop} onScanIncluded={noop} />,
    )
  const html = row(disk)
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('aria-label="Include /fixture on Fixture Mac in scans"')
  expect(html.indexOf('type="checkbox"')).toBeLessThan(html.indexOf('<button'))
  expect(html).toContain('checked=""')
  expect(row({ ...disk, scanIncluded: false })).not.toContain('checked=""')
  expect(row({ ...disk, machine: { ...disk.machine!, kind: 'historical' } })).not.toContain('type="checkbox"')
})

test('both scan modes have a clear disabled state for zero selected live roots', () => {
  const panel = (disks: Disk[], selectionSaving = false) =>
    renderToStaticMarkup(
      <ScanPanel
        disks={disks}
        progress={null}
        deleting={false}
        elevated
        selectionSaving={selectionSaving}
        onError={noop}
      />,
    )
  const none = panel([{ ...disk, scanIncluded: false }])
  expect(none).toContain('Scan selected')
  expect(none).toContain('Quick scan (experimental)')
  expect(none.match(/disabled=""/g)).toHaveLength(2)
  expect(none).toContain('Select a root using its checkbox to scan.')
  expect(panel([disk])).not.toContain('disabled=""')
  expect(panel([disk], true).match(/disabled=""/g)).toHaveLength(2)
  expect(panel([{ ...disk, machine: { ...disk.machine!, kind: 'historical' } }])).toContain('disabled=""')
})

test('cleanup actions expire at the scan start deadline, including queues viewed under another scan', () => {
  const now = 10_000_000
  const latest = {
    id: 2,
    diskId: disk.id,
    startedAt: now - DELETE_SCAN_MAX_AGE_MS,
    finishedAt: now,
    status: 'complete' as const,
    size: 1,
    files: 1,
    dirs: 1,
    errors: 0,
    durationMs: 1,
    method: null,
    fallback: null,
  }
  expect(cleanupScanProblem({ ...disk, latestScan: latest }, now)).toBeNull()
  expect(cleanupScanProblem({ ...disk, latestScan: latest }, now + 1)).toContain('Scan this root again')
  expect(cleanupScanProblem({ ...disk, latestScan: { ...latest, diskId: disk.id + 1 } }, now)).toContain(
    'Scan this root again',
  )
  expect(cleanupScanProblem({ ...disk, latestScan: { ...latest, startedAt: now + 1 } }, now)).toContain(
    'Scan this root again',
  )
  expect(cleanupScanProblem(disk, now)).toContain('Scan this root again')
})
