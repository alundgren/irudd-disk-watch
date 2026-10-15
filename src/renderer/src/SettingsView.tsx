import type { Disk, HideChange, ScanSummary } from '../../shared/types'
import { useState } from 'react'
import { api, formatBytes, formatCount, formatWhen, isWindows, isHistorical, machineLabel } from './api'

interface SettingsViewProps {
  disk: Disk
  scans: ScanSummary[]
  scanning: boolean
  onChanged(): void
  onReinspected(): void
  onRemoved(): void
  onHideChange(change: HideChange): Promise<void>
  onEditHide(path: string): void
  onError(error: unknown): void
}

export function SettingsView({
  disk,
  scans,
  scanning,
  onChanged,
  onRemoved,
  onReinspected,
  onHideChange,
  onEditHide,
  onError,
}: SettingsViewProps) {
  const [excludePath, setExcludePath] = useState('')
  const [busy, setBusy] = useState(false)
  const [metadata, setMetadata] = useState<boolean | null>(null)
  const change = async (change: HideChange) => {
    setBusy(true)
    if (change.type === 'metadata') setMetadata(change.enabled)
    try {
      await onHideChange(change)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
      setMetadata(null)
    }
  }
  const setExcludes = async (paths: string[]) => {
    try {
      await api.setExcludes(disk.id, paths)
      onChanged()
    } catch (error) {
      onError(error)
    }
  }
  const addExclude = async (kind: 'file' | 'dir') => {
    setBusy(true)
    try {
      const path = disk.machine?.kind === 'ssh' ? excludePath : await api.pickExclude(disk.id, kind)
      if (path) {
        await api.addExclude(disk.id, path)
        setExcludePath('')
        onChanged()
      }
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  const deleteScan = async (scan: ScanSummary) => {
    if (!confirm(`Delete the scan from ${formatWhen(scan.startedAt)}? Its tree and comparisons go away.`)) return
    await api.deleteScan(scan.id)
    onChanged()
  }
  const removeDisk = async () => {
    if (
      !confirm(
        `Stop tracking ${disk.root}? All ${scans.length} scans of it are deleted. Files on disk are not touched.`,
      )
    )
      return
    await api.removeDisk(disk.id)
    onRemoved()
  }

  return (
    <div className="view settings">
      <section>
        <h2>{machineLabel(disk)}</h2>
        <p className="path">{disk.root}</p>
        {disk.nativeRoot && (
          <p className="muted small">
            {disk.nativeRoot.filesystem} · Root observed {formatWhen(disk.nativeRoot.observedAt)}. Capacity is a saved
            observation and may be stale.
          </p>
        )}
        {!isWindows(disk) && !isHistorical(disk) && (
          <>
            <p className="muted small">
              After a remount or root replacement, reinspect this saved path. History stays available; cleanup is
              disabled and requires a fresh scan.
            </p>
            <button
              disabled={busy || scanning}
              onClick={async () => {
                if (
                  !confirm(
                    `Reinspect ${disk.root} on ${machineLabel(disk)}? Accept its current root identity, keep saved history and rules, clear queued deletions, and disable cleanup. Scan again before enabling deletion.`,
                  )
                )
                  return
                setBusy(true)
                try {
                  await api.reinspectRoot(disk.id)
                  onReinspected()
                } catch (error) {
                  onError(error)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Reinspect root
            </button>
          </>
        )}
        {isHistorical(disk) && (
          <p className="muted">Saved history only. This machine is unavailable for scanning or file actions.</p>
        )}
      </section>
      {!isWindows(disk) && !isHistorical(disk) && (
        <section>
          <h2>Permanent cleanup</h2>
          <p className="muted">
            Cleanup supports APFS and ext4. Enable only for a writable tree you own, with other programs paused from
            changing it. Native checks refuse changed roots, mounts and file identities. A concurrent writer can still
            rename an open folder. Roots needing stronger protection should stay scan-only.
          </p>
          <label className="metadata-toggle">
            <input
              type="checkbox"
              checked={disk.cleanupEnabled === true}
              disabled={busy || scanning}
              onChange={async (event) => {
                const enabled = event.target.checked
                setBusy(true)
                try {
                  await api.setCleanupEnabled(disk.id, enabled)
                  onChanged()
                } catch (error) {
                  onError(error)
                } finally {
                  setBusy(false)
                }
              }}
            />{' '}
            Enable permanent deletion for this root
          </label>
        </section>
      )}
      <section>
        <h2>Hidden from views</h2>
        <p className="muted">These paths are hidden in every scan and comparison. Scans still capture them.</p>
        <ul className="plain-list hidden-paths">
          {disk.hides.paths.map((path) => (
            <li key={path}>
              <span className="path">{path}</span>
              <button disabled={busy} onClick={() => onEditHide(path)}>
                Edit
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  change({
                    type: 'remove',
                    path,
                    components: disk.hides.rules?.find((rule) => rule.path === path)?.components,
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {isWindows(disk) && (
          <>
            <label className="metadata-toggle">
              <input
                type="checkbox"
                checked={metadata ?? disk.hides.metadata}
                disabled={busy}
                onChange={(event) => change({ type: 'metadata', enabled: event.target.checked })}
              />{' '}
              Hide NTFS metadata at the drive root
            </label>
            <p className="muted small">
              {disk.hides.metadataEligible
                ? 'Applies to known NTFS metadata files and $Extend at this drive root.'
                : 'Takes effect only for a drive root confirmed by a completed MFT scan.'}{' '}
              System Volume Information, Recycle Bin and WindowsApps stay visible.
            </p>
          </>
        )}
      </section>
      <section>
        <h2>Excluded files and folders</h2>
        <p className="muted">Hidden immediately from views and comparisons, and skipped by future scans.</p>
        {disk.excludes.length > 0 && (
          <ul className="plain-list">
            {disk.excludes.map((path) => (
              <li key={path}>
                <span className="path">{path}</span>
                <button disabled={busy} onClick={() => setExcludes(disk.excludes.filter((p) => p !== path))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {disk.machine?.kind === 'ssh' && (
          <label className="remote-exclude">
            Remote path
            <input
              className="path"
              value={excludePath}
              onChange={(event) => setExcludePath(event.target.value)}
              placeholder="Absolute path on the tracked machine"
              disabled={busy}
            />
          </label>
        )}
        <button
          disabled={busy || isHistorical(disk) || (disk.machine?.kind === 'ssh' && !excludePath.trim())}
          onClick={() => addExclude('dir')}
        >
          Add excluded folder…
        </button>{' '}
        <button
          disabled={busy || isHistorical(disk) || (disk.machine?.kind === 'ssh' && !excludePath.trim())}
          onClick={() => addExclude('file')}
        >
          Add excluded file…
        </button>
      </section>

      <section>
        <h2>Scan history</h2>
        <ul className="plain-list scans">
          {scans.map((scan) => (
            <li key={scan.id}>
              <span>{formatWhen(scan.startedAt)}</span>
              {scan.status === 'complete' ? (
                <span className="muted" title={scan.fallback ?? undefined}>
                  {formatBytes(scan.size)} · {formatCount(scan.files)} files ·{' '}
                  {((scan.durationMs ?? 0) / 1000).toFixed(1)} s · {scan.method === 'mft' ? 'MFT' : 'folder walk'}
                  {scan.coverage === 'partial' ? ' · partial coverage, unavailable for Changes' : ''}
                </span>
              ) : (
                <span className="scan-history-result">
                  <span className="muted">{scan.status}</span>
                  {scan.message && <span className="scan-message">{scan.message}</span>}
                </span>
              )}
              <button
                className="danger-quiet"
                disabled={scanning || scan.status === 'running'}
                onClick={() => deleteScan(scan)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Stop tracking</h2>
        <button className="danger" disabled={scanning} onClick={removeDisk}>
          Stop tracking {disk.root}
        </button>
      </section>
    </div>
  )
}
