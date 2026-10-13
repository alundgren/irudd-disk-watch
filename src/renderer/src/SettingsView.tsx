import type { Disk, ScanSummary } from '../../shared/types'
import { api, formatBytes, formatCount, formatWhen } from './api'

interface SettingsViewProps {
  disk: Disk
  scans: ScanSummary[]
  scanning: boolean
  onChanged(): void
  onRemoved(): void
}

export function SettingsView({ disk, scans, scanning, onChanged, onRemoved }: SettingsViewProps) {
  const setExcludes = async (paths: string[]) => {
    await api.setExcludes(disk.id, paths)
    onChanged()
  }
  const addExclude = async () => {
    const path = await api.pickExclude(disk.id)
    if (path) await setExcludes([...disk.excludes, path])
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
        <h2>Excluded folders</h2>
        <p className="muted">Scans skip these folders and everything inside them. Changes apply to the next scan.</p>
        {disk.excludes.length > 0 && (
          <ul className="plain-list">
            {disk.excludes.map((path) => (
              <li key={path}>
                <span className="path">{path}</span>
                <button onClick={() => setExcludes(disk.excludes.filter((p) => p !== path))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={addExclude}>Add excluded folder…</button>
      </section>

      <section>
        <h2>Scan history</h2>
        <ul className="plain-list scans">
          {scans.map((scan) => (
            <li key={scan.id}>
              <span>{formatWhen(scan.startedAt)}</span>
              {scan.status === 'complete' ? (
                <span className="muted">
                  {formatBytes(scan.size)} · {formatCount(scan.files)} files ·{' '}
                  {((scan.durationMs ?? 0) / 1000).toFixed(1)} s
                </span>
              ) : (
                <span className="muted">{scan.status}</span>
              )}
              <button className="danger-quiet" disabled={scan.status === 'running'} onClick={() => deleteScan(scan)}>
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
