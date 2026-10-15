import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vite-plus/test'
import type { NativeVolume, ScanSummary } from '../../shared/types'
import { canTrackVolume, volumeChoices, volumeExplanation } from './volumeChoice'
import { initialDiscovery, volumeDiscovery } from './volumeDiscovery'

vi.stubGlobal('window', {
  diskWatch: new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error('Rendering must not start an operation.')
        }
      },
    },
  ),
})
const { VolumeOption } = await import('./VolumeChooser')
const { ScanDiagnostics } = await import('./ScanDiagnostics')
const { SettingsView } = await import('./SettingsView')
const volume: NativeVolume = {
  id: 'data',
  name: 'Data',
  path: '/System/Volumes/Data',
  pathBytes: Buffer.from('/System/Volumes/Data').toString('base64'),
  os: 'macos',
  filesystem: 'apfs',
  kind: 'local',
  readOnly: false,
  capacity: { total: 1000, free: 500 },
  recommended: true,
  mount: '3',
  device: '1',
}

test('the Data recommendation precedes other drives while system filtering keeps read-only drives available', () => {
  const readonly = { ...volume, id: 'readonly', name: 'Archive', recommended: false, readOnly: true }
  const system = {
    ...volume,
    id: 'system',
    name: 'System',
    path: '/',
    kind: 'system' as const,
    recommended: false,
    readOnly: true,
  }
  expect(volumeChoices([system, readonly, volume], false).map((item) => item.id)).toEqual(['data', 'readonly'])
  expect(volumeChoices([system, readonly, volume], true).map((item) => item.id)).toEqual(['data', 'readonly', 'system'])
  expect(canTrackVolume(readonly)).toBe(true)
  expect(volumeExplanation(volume)).toBe('Apps and your files')
  expect(volumeExplanation(system)).toContain('does not include Data')
})

test('Windows unknown identities and raw device paths require the custom inspection flow', () => {
  const windows = {
    ...volume,
    os: 'windows' as const,
    path: 'C:\\',
    pathBytes: undefined,
    mount: undefined,
    device: undefined,
  }
  expect(canTrackVolume(windows)).toBe(false)
  expect(canTrackVolume({ ...windows, device: '1' })).toBe(true)
  expect(canTrackVolume({ ...windows, path: '\\\\server\\share\\', mount: 'network-volume' })).toBe(true)
  expect(canTrackVolume({ ...windows, path: '\\\\?\\Volume{example}\\', device: '1' })).toBe(false)
  expect(canTrackVolume({ ...volume, mount: undefined })).toBe(false)
})

test('read-only drive rows retain selection and show actual path, filesystem and capacity', () => {
  const html = renderToStaticMarkup(
    <VolumeOption volume={{ ...volume, readOnly: true }} selected={false} onSelect={() => {}} onFolder={() => {}} />,
  )
  expect(html).toContain('/System/Volumes/Data')
  expect(html).toContain('apfs')
  expect(html).toContain('500 B free of 1000 B')
  expect(html).toContain('Read-only, scanning available')
  expect(html).not.toContain('disabled=""')
  const unknown = renderToStaticMarkup(
    <VolumeOption
      volume={{
        ...volume,
        os: 'windows',
        path: 'C:\\',
        mount: undefined,
        device: undefined,
        capacity: null,
        filesystem: null,
      }}
      selected={false}
      onSelect={() => {}}
      onFolder={() => {}}
    />,
  )
  expect(unknown).toContain('disabled=""')
  expect(unknown).toContain('Enter a folder path')
  expect(unknown).toContain('Capacity unavailable')
  expect(unknown).toContain('Filesystem unavailable')
})

test('a zero-byte partial scan warns about unknown coverage and offers another drive without starting work', () => {
  const scan: ScanSummary = {
    id: 1,
    diskId: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'complete',
    size: 0,
    files: 0,
    dirs: 1,
    errors: 7,
    durationMs: 1,
    method: 'walk',
    fallback: null,
    coverage: 'partial',
  }
  const html = renderToStaticMarkup(<ScanDiagnostics scan={scan} unix onChooseDrive={() => {}} />)
  expect(html).toContain('does not show that the drive is empty')
  expect(html).toContain('Choose a drive')
  expect(html).toContain('7 items could')
  expect(html).toContain('aria-expanded="false"')
})

const discovered = {
  machine: { id: 'local-mac', kind: 'local' as const, os: 'macos' as const, name: 'Test computer' },
  observedAt: 1,
  volumes: [volume],
  truncated: false,
  errors: 0,
}

test('discovery defaults to a trackable recommended Data row, preserving the root observation unchanged', () => {
  const system = { ...volume, id: 'system', kind: 'system' as const, path: '/' }
  const unknown = {
    ...volume,
    id: 'unknown',
    os: 'windows' as const,
    mount: undefined,
    device: undefined,
    path: 'D:\\',
  }
  const result = { ...discovered, volumes: [system, unknown, volume] }
  const state = volumeDiscovery(volumeDiscovery(initialDiscovery, { type: 'start', request: 1 }), {
    type: 'received',
    request: 1,
    discovery: result,
  })
  expect(state.selected).toBe('data')
  expect(state.discovery).toBe(result)
  expect(state.discovery!.volumes[2]).toBe(volume)
})

test('refresh and execution-source changes discard stale replies and clear the previous root selection', () => {
  let state = volumeDiscovery(initialDiscovery, { type: 'start', request: 1 })
  state = volumeDiscovery(state, { type: 'received', request: 1, discovery: discovered })
  expect(state.selected).toBe('data')
  state = volumeDiscovery(state, { type: 'start', request: 2 })
  expect(state.selected).toBeNull()
  expect(state.discovery).toBeNull()
  state = volumeDiscovery(state, { type: 'invalidate', request: 3 })
  state = volumeDiscovery(state, { type: 'start', request: 4 })
  const remote = {
    ...discovered,
    machine: { id: 'remote-linux', kind: 'ssh' as const, os: 'linux' as const, name: 'Test remote' },
    volumes: [
      {
        ...volume,
        os: 'linux' as const,
        id: 'linux-root',
        path: '/home/test',
        pathBytes: Buffer.from('/home/test').toString('base64'),
      },
    ],
  }
  state = volumeDiscovery(state, { type: 'received', request: 4, discovery: remote })
  state = volumeDiscovery(state, { type: 'received', request: 2, discovery: discovered })
  state = volumeDiscovery(state, { type: 'failed', request: 1, message: 'Old connection failed' })
  expect(state.discovery!.machine.id).toBe('remote-linux')
  expect(state.selected).toBe('linux-root')
  expect(state.error).toBeNull()
})

test('cancelled discovery cannot be restored by a delayed result or connection failure', () => {
  let state = volumeDiscovery(initialDiscovery, { type: 'start', request: 1 })
  state = volumeDiscovery(state, { type: 'invalidate', request: 2 })
  state = volumeDiscovery(state, { type: 'received', request: 1, discovery: discovered })
  state = volumeDiscovery(state, { type: 'failed', request: 1, message: 'Cancelled connection' })
  expect(state.discovery).toBeNull()
  expect(state.selected).toBeNull()
  expect(state.loading).toBe(false)
  expect(state.error).toBeNull()
})

test('Unix network rows retain nullable observations without losing their mount identity', () => {
  const network = {
    ...volume,
    id: 'network',
    os: 'linux' as const,
    kind: 'network' as const,
    recommended: false,
    filesystem: null,
    readOnly: null,
    capacity: null,
    device: undefined,
  }
  expect(canTrackVolume(network)).toBe(true)
  const html = renderToStaticMarkup(
    <VolumeOption volume={network} selected={false} onSelect={() => {}} onFolder={() => {}} />,
  )
  expect(html).toContain('Network')
  expect(html).toContain('Capacity unavailable')
  expect(html).toContain('Write access unknown')
  expect(html).not.toContain('disabled=""')
})

test('an external recommended Mac disk cannot displace or use the explanation of the Data volume', () => {
  const external = { ...volume, id: 'external', name: 'External', path: '/Volumes/External', recommended: true }
  expect(volumeExplanation(external)).toBeNull()
  expect(volumeChoices([external, volume], false)[0]!.id).toBe(volume.id)
  const state = volumeDiscovery(volumeDiscovery(initialDiscovery, { type: 'start', request: 1 }), {
    type: 'received',
    request: 1,
    discovery: { ...discovered, volumes: [external, volume] },
  })
  expect(state.selected).toBe(volume.id)
})

test('partial Windows scans do not claim that legacy cleanup requires complete coverage', () => {
  const scan: ScanSummary = {
    id: 1,
    diskId: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'complete',
    size: 0,
    files: 0,
    dirs: 1,
    errors: 1,
    durationMs: 1,
    method: 'walk',
    fallback: null,
    coverage: 'partial',
  }
  const html = renderToStaticMarkup(<ScanDiagnostics scan={scan} unix={false} onChooseDrive={() => {}} />)
  expect(html).toContain('Changes requires a scan with complete coverage')
  expect(html).not.toContain('cleanup require')
})

test('a complete scan with only skipped nested mounts explains captured scope and offers another drive', () => {
  const scan: ScanSummary = {
    id: 1,
    diskId: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'complete',
    size: 0,
    files: 0,
    dirs: 1,
    errors: 0,
    durationMs: 1,
    method: 'walk',
    fallback: null,
    coverage: 'complete',
    skipped: { symlinks: 0, special: 0, mounts: 2 },
  }
  const html = renderToStaticMarkup(<ScanDiagnostics scan={scan} unix onChooseDrive={() => {}} />)
  expect(html).toContain('Nested mounts were intentionally skipped')
  expect(html).toContain('Choose a drive')
  expect(html).not.toContain('partial scan')
  expect(scan.coverage).toBe('complete')
})

test('saved failed and cancelled scan messages remain visible in Settings without a connection', () => {
  const scan: ScanSummary = {
    id: 1,
    diskId: 1,
    startedAt: 1,
    finishedAt: 2,
    status: 'failed',
    size: 0,
    files: 0,
    dirs: 0,
    errors: 0,
    durationMs: null,
    method: null,
    fallback: null,
    message: 'Worker exited before completion',
  }
  const disk = {
    id: 1,
    root: 'C:\\',
    rootNode: 1,
    excludes: [],
    capacity: null,
    latestScan: null,
    hides: { paths: [], metadata: false, metadataEligible: false, revision: 0 },
  }
  const html = renderToStaticMarkup(
    <SettingsView
      disk={disk}
      scans={[scan, { ...scan, id: 2, status: 'cancelled', message: 'Cancelled before completion' }]}
      scanning={false}
      onChanged={() => {}}
      onReinspected={() => {}}
      onRemoved={() => {}}
      onHideChange={async () => {}}
      onEditHide={() => {}}
      onError={() => {}}
    />,
  )
  expect(html).toContain('Worker exited before completion')
  expect(html).toContain('Cancelled before completion')
})
