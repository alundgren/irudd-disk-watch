import type { Disk, HideChange, ScanSummary } from '../../shared/types'
import { useState } from 'react'
import { api, formatBytes, formatCount, formatWhen } from './api'

interface SettingsViewProps {
  disk: Disk
  scans: ScanSummary[]
  scanning: boolean
  onChanged(): void
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
  onHideChange,
  onEditHide,
  onError,
}: SettingsViewProps) {
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
      const path = await api.pickExclude(disk.id, kind)
      if (path) {
        await api.addExclude(disk.id, path)
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
        <h2>Hidden from views</h2>
        <p className="muted">These paths are hidden in every scan and comparison. Scans still capture them.</p>
        <ul className="plain-list hidden-paths">
          {disk.hides.paths.map((path) => (
            <li key={path}>
              <span className="path">{path}</span>
              <button disabled={busy} onClick={() => onEditHide(path)}>
                Edit
              </button>
              <button disabled={busy} onClick={() => change({ type: 'remove', path })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
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
        <button disabled={busy} onClick={() => addExclude('dir')}>
          Add excluded folder…
        </button>{' '}
        <button disabled={busy} onClick={() => addExclude('file')}>
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
                </span>
              ) : (
                <span className="muted">{scan.status}</span>
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
