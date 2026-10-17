import { expect, it } from 'vite-plus/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateSettings } from './UpdateSettings'
import type { UpdateState } from '../../shared/updates'
const render = (state: UpdateState, filesystemBusy = false) =>
  renderToStaticMarkup(
    <UpdateSettings
      state={state}
      filesystemBusy={filesystemBusy}
      onCheck={() => {}}
      onDownload={() => {}}
      onInstall={() => {}}
    />,
  )
it('keeps explicit restart disabled while filesystem operations are active', () => {
  const html = render({ phase: 'ready', currentVersion: '0.2.0', availableVersion: '0.3.0' }, true)
  expect(html).toContain('disabled=""')
  expect(html).toContain('Install and restart')
  expect(html).toContain('Finish or cancel')
})
it('shows download progress, actionable failure and unmanaged installation guidance', () => {
  expect(render({ phase: 'downloading', currentVersion: '0.2.0' })).toContain('<progress')
  const failed = render({
    phase: 'error',
    currentVersion: '0.2.0',
    retry: 'download',
    message: 'SHA256 verification failed',
  })
  expect(failed).toContain('role="alert"')
  expect(failed).toContain('SHA256 verification failed')
  expect(failed).toContain('Retry download')
  expect(render({ phase: 'unmanaged', currentVersion: '0.2.0' })).toContain('Install the prebuilt app')
})
