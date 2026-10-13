import { useCallback, useEffect, useState } from 'react'
import type { Disk, ScanProgress, ScanSummary } from '../../shared/types'
import { api, formatBytes, formatCount, formatWhen } from './api'
import { ChangesView } from './ChangesView'
import { SettingsView } from './SettingsView'
import { SpaceView } from './SpaceView'

type Tab = 'space' | 'changes' | 'settings'

interface Notice {
  text: string
  undo?: () => void
}

export function App() {
  const [disks, setDisks] = useState<Disk[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('space')
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [elevated, setElevated] = useState(true)

  const disk = disks?.find((d) => d.id === selectedId) ?? disks?.[0] ?? null

  const refresh = useCallback(async () => {
    const loaded = await api.listDisks()
    setDisks(loaded)
  }, [])

  useEffect(() => {
    refresh()
    api.currentScan().then(setProgress)
    api.isElevated().then(setElevated)
    return api.onScanEvent((event) => {
      if (event.type === 'progress') return setProgress(event.progress)
      if (event.type === 'run-finished') setProgress(null)
      if (event.type === 'disk-finished' && event.status === 'failed') {
        setNotice({ text: `A scan failed: ${event.message}` })
      }
      refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (disk) api.listScans(disk.id).then(setScans)
  }, [disk])

  const addDisk = async () => {
    const added = await api.pickAndAddDisk()
    if (!added) return
    await refresh()
    setSelectedId(added.id)
    setTab('space')
  }

  const exclude = async (path: string) => {
    if (!disk) return
    const before = disk.excludes
    await api.setExcludes(disk.id, [...before, path])
    await refresh()
    setNotice({
      text: `${path} is excluded from the next scan.`,
      undo: async () => {
        await api.setExcludes(disk.id, before)
        await refresh()
        setNotice(null)
      },
    })
  }

  if (!disks) return null
  const complete = scans.filter((scan) => scan.status === 'complete')
  const scanning = progress !== null

  return (
    <div className="app">
      <nav className="sidebar">
        <h1>Disk Watch</h1>
        {disks.length > 0 && (
          <ScanPanel disks={disks} progress={progress} elevated={elevated} onError={(text) => setNotice({ text })} />
        )}
        <ul className="disks">
          {disks.map((d) => (
            <li key={d.id}>
              <button className={d.id === disk?.id ? 'disk selected' : 'disk'} onClick={() => setSelectedId(d.id)}>
                <span className="disk-root">{d.root}</span>
                {d.capacity && (
                  <span
                    className="capacity"
                    title={`${formatBytes(d.capacity.free)} free of ${formatBytes(d.capacity.total)}`}
                  >
                    <span style={{ width: `${(1 - d.capacity.free / d.capacity.total) * 100}%` }} />
                  </span>
                )}
                <span className="muted small">
                  {d.capacity ? `${formatBytes(d.capacity.free)} free · ` : ''}
                  {progress?.diskId === d.id
                    ? 'scanning now'
                    : d.latestScan
                      ? `scanned ${formatWhen(d.latestScan.startedAt)}`
                      : 'never scanned'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button className="add-disk" onClick={addDisk}>
          + Track a drive or folder
        </button>
      </nav>

      <main>
        {!disk ? (
          <div className="welcome">
            <h2>Find out where your disk space went</h2>
            <p>Pick the drives to track, then scan them. Scan again later to see what grew.</p>
            <button className="primary" onClick={addDisk}>
              Track a drive or folder
            </button>
          </div>
        ) : (
          <>
            <header className="disk-header">
              <h2>{disk.root}</h2>
            </header>
            {notice && (
              <div className="notice" role="status">
                <span>{notice.text}</span>
                {notice.undo && <button onClick={notice.undo}>Undo</button>}
                <button aria-label="Dismiss" onClick={() => setNotice(null)}>
                  ✕
                </button>
              </div>
            )}
            <div className="tabs" role="tablist">
              {(['space', 'changes', 'settings'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'tab active' : 'tab'}
                  onClick={() => setTab(t)}
                >
                  {{ space: 'Space', changes: 'Changes', settings: 'Settings' }[t]}
                </button>
              ))}
            </div>
            {tab === 'settings' ? (
              <SettingsView
                disk={disk}
                scans={scans}
                scanning={scanning}
                onChanged={() => {
                  refresh()
                  api.listScans(disk.id).then(setScans)
                }}
                onRemoved={() => {
                  setSelectedId(null)
                  setTab('space')
                  refresh()
                }}
              />
            ) : complete.length === 0 ? (
              <p className="empty">No scans yet. Use Scan all drives to see what takes up the space.</p>
            ) : tab === 'space' ? (
              <SpaceView key={`${disk.id}-${complete[0]!.id}`} disk={disk} scans={complete} onExclude={exclude} />
            ) : complete.length < 2 ? (
              <p className="empty">Changes compare two scans. Scan again later to see what came and went.</p>
            ) : (
              <ChangesView key={`${disk.id}-${complete[0]!.id}`} disk={disk} scans={complete} onExclude={exclude} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

interface ScanPanelProps {
  disks: Disk[]
  progress: ScanProgress | null
  elevated: boolean
  onError(text: string): void
}

function ScanPanel({ disks, progress, elevated, onError }: ScanPanelProps) {
  const restart = () => api.restartElevated().catch((err: Error) => onError(err.message))
  if (progress) {
    const root = disks.find((d) => d.id === progress.diskId)?.root ?? ''
    return (
      <div className="scan-panel" role="status">
        <div className="scan-progress">
          <span className="spinner" aria-hidden />
          <span className="strong">
            Scanning {root}
            {progress.count > 1 && (
              <span className="muted">
                {' '}
                · {progress.index + 1} of {progress.count}
              </span>
            )}
          </span>
        </div>
        <span className="muted small">{describeProgress(progress)}</span>
        <button onClick={() => api.cancelScan()}>Cancel</button>
      </div>
    )
  }
  return (
    <div className="scan-panel">
      <button className="primary" onClick={() => api.startScan().catch((err: Error) => onError(err.message))}>
        Scan all drives
      </button>
      {!elevated && (
        <p className="muted small">
          Disk Watch is not running as administrator, so scans list folders one by one. That is slower and counts
          hard-linked files once per link.{' '}
          <button className="link" onClick={restart}>
            Restart as administrator
          </button>
        </p>
      )}
    </div>
  )
}

function describeProgress(progress: ScanProgress): string {
  switch (progress.phase) {
    case 'starting':
      return 'Starting…'
    case 'reading':
      return `Read ${formatCount(progress.files)} files · ${formatBytes(progress.bytes)}`
    case 'saving':
      return `Saving ${formatCount(progress.rows)} entries`
  }
}
