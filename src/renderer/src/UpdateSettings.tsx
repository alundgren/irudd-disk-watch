import type { UpdateState } from '../../shared/updates'

/** State and actions are supplied by the parent view; this component has no IPC or filesystem access. */
export function UpdateSettings({
  state,
  filesystemBusy,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: UpdateState
  filesystemBusy: boolean
  onCheck(): void
  onDownload(): void
  onInstall(): void
}) {
  const pending = ['checking', 'downloading', 'installing'].includes(state.phase)
  const download = state.phase === 'available' || (state.phase === 'error' && state.retry === 'download')
  const install = state.phase === 'ready' || (state.phase === 'error' && state.retry === 'install')
  return (
    <section aria-labelledby="app-updates-heading" aria-busy={pending}>
      <h2 id="app-updates-heading">App updates</h2>
      <p>
        Disk Watch {state.currentVersion}
        {state.availableVersion &&
          state.availableVersion !== state.currentVersion &&
          ` · Latest stable ${state.availableVersion}`}
      </p>
      <div role={state.phase === 'error' ? 'alert' : 'status'} aria-live="polite">
        {state.phase === 'current' ? <p>You have the latest stable version.</p> : null}
        {state.phase === 'available' ? <p>A new version is available. Downloading keeps the app running.</p> : null}
        {state.message ? <p className="muted">{state.message}</p> : null}
        {pending ? <progress aria-label={state.message ?? 'Updating Disk Watch'} /> : null}
      </div>
      {state.phase === 'unmanaged' ? (
        <p>
          <a
            href="https://github.com/alundgren/irudd-disk-watch/blob/main/docs/installing.md"
            target="_blank"
            rel="noreferrer"
          >
            Install the prebuilt app
          </a>
        </p>
      ) : null}
      {install && filesystemBusy ? (
        <p className="muted">Finish or cancel scans and file operations before restarting.</p>
      ) : null}
      {download ? (
        <button disabled={pending} onClick={onDownload}>
          {state.phase === 'error' ? 'Retry download' : 'Download update'}
        </button>
      ) : null}
      {install ? (
        <button disabled={pending || filesystemBusy} onClick={onInstall}>
          {state.phase === 'error' ? 'Retry install and restart' : 'Install and restart'}
        </button>
      ) : null}
      {!download && !install ? (
        <button disabled={pending} onClick={onCheck}>
          {state.phase === 'error' ? 'Retry check' : 'Check for updates'}
        </button>
      ) : null}
    </section>
  )
}
