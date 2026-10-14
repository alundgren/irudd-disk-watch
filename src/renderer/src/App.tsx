import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { containsPath, pathKey } from '../../shared/paths'
import type {
  Comparison,
  Disk,
  DiskSnapshot,
  HideChange,
  HideSettings,
  NodeKind,
  ScanProgress,
  StagedDelete,
  TreeRow,
  ViewTotal,
} from '../../shared/types'
import { api, formatBytes, formatCount, formatWhen } from './api'
import { ChangesView } from './ChangesView'
import { HideDialog } from './HideDialog'
import { SettingsView } from './SettingsView'
import { SpaceView } from './SpaceView'

type Tab = 'space' | 'changes' | 'settings'
interface Intent {
  diskId: number
  tab: Tab
  scanId?: number
  fromId?: number
  toId?: number
}
type Page = DiskSnapshot &
  (
    | { tab: 'space'; scanId: number | null; rows: TreeRow[]; total: ViewTotal | null }
    | { tab: 'changes'; comparison: Comparison | null }
    | { tab: 'settings' }
  )
type Navigation =
  { status: 'ready' } | { status: 'pending'; intent: Intent } | { status: 'error'; intent: Intent; message: string }
interface Notice {
  text: string
  undo?: () => void
}

interface HideOwner {
  diskId: number
  root: string
  page: Page
  request: number
  action: number
}

interface ContextTarget {
  nodeId: number
  path?: string
  kind?: Exclude<NodeKind, 'rest'>
  size?: number
  files?: number
  canDelete?: boolean
}

function summarizeStaged(items: StagedDelete[]) {
  const top = items.filter(
    (item) => !items.some((other) => pathKey(other.path) !== pathKey(item.path) && containsPath(other.path, item.path)),
  )
  return {
    items,
    top,
    size: top.reduce((sum, item) => sum + item.size, 0),
    files: top.reduce((sum, item) => sum + item.files, 0),
  }
}

export function App() {
  const [disks, setDisks] = useState<Disk[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [navigation, setNavigation] = useState<Navigation>({ status: 'ready' })
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [elevated, setElevated] = useState(true)
  const [stagedByDisk, setStagedByDisk] = useState<Record<number, StagedDelete[]>>({})
  const [deletingDisk, setDeletingDisk] = useState<number | null>(null)
  const deleting = deletingDisk !== null
  const deletingRef = useRef(false)
  const staging = useRef(new Map<string, symbol>())
  const [showQueue, setShowQueue] = useState(false)
  const [menu, setMenu] = useState<{
    owner: HideOwner
    x: number
    y: number
    target: ContextTarget
    origin: HTMLElement
  } | null>(null)
  const menuElement = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<{ owner: HideOwner; path: string; original?: string } | null>(null)
  const request = useRef(0)
  const hideAction = useRef(0)
  const intent = useRef<Intent | null>(null)
  const activePage = useRef<Page | null>(null)
  activePage.current = page
  const report = (error: unknown) => setNotice({ text: error instanceof Error ? error.message : String(error) })

  const navigate = useCallback(async (next: Intent) => {
    staging.current.clear()
    const identity = ++request.current
    ++hideAction.current
    intent.current = next
    setNavigation({ status: 'pending', intent: next })
    setMenu(null)
    setDialog(null)
    try {
      const snapshot = await api.openDisk(next.diskId)
      if (identity !== request.current) return
      const scans = snapshot.scans.filter((scan) => scan.status === 'complete')
      const revision = snapshot.disk.hides.revision
      let prepared: Page
      if (next.tab === 'settings') prepared = { ...snapshot, tab: 'settings' }
      else if (next.tab === 'space') {
        const scan = scans.find((scan) => scan.id === next.scanId) ?? scans[0]
        const [rows, total] = scan
          ? await Promise.all([api.children(scan.id, snapshot.disk.rootNode, revision), api.totals(scan.id, revision)])
          : [[], null]
        prepared = { ...snapshot, tab: 'space', scanId: scan?.id ?? null, rows, total }
      } else {
        let comparison: Comparison | null = null
        if (scans.length >= 2) {
          const a = scans.find((scan) => scan.id === next.fromId) ?? scans[1]!
          const b = scans.find((scan) => scan.id === next.toId) ?? scans[0]!
          const [from, to] = [a, b].sort((x, y) => x.startedAt - y.startedAt) as [typeof a, typeof b]
          comparison = await api.compare(from.id, to.id, revision)
          if (
            comparison.diskId !== next.diskId ||
            comparison.revision !== revision ||
            comparison.fromId !== from.id ||
            comparison.toId !== to.id
          )
            throw new Error('The comparison changed while loading. Try again.')
          next = { ...next, fromId: from.id, toId: to.id }
        }
        prepared = { ...snapshot, tab: 'changes', comparison }
      }
      if (identity !== request.current) return
      intent.current = next
      setMenu(null)
      setDialog(null)
      setPage(prepared)
      setDisks((current) => current.map((disk) => (disk.id === prepared.disk.id ? prepared.disk : disk)))
      setNavigation({ status: 'ready' })
    } catch (error) {
      if (identity === request.current)
        setNavigation({
          status: 'error',
          intent: next,
          message: error instanceof Error ? error.message : String(error),
        })
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const loaded = await api.listDisks()
      setDisks(loaded)
      setStagedByDisk((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => loaded.some((disk) => disk.id === Number(id)))),
      )
      const current = intent.current
      if (current && loaded.some((disk) => disk.id === current.diskId)) await navigate(current)
      else if (loaded[0]) await navigate({ diskId: loaded[0].id, tab: 'space' })
      else {
        ++request.current
        intent.current = null
        setPage(null)
        setNavigation({ status: 'ready' })
      }
    } catch (error) {
      report(error)
    }
  }, [navigate])

  useEffect(() => {
    void refresh()
    api.currentScan().then(setProgress).catch(report)
    api.isElevated().then(setElevated).catch(report)
    return api.onScanEvent((event) => {
      if (event.type === 'progress') {
        setProgress(event.progress)
        return
      }
      if (event.type === 'run-finished') setProgress(null)
      if (event.type === 'disk-finished' && event.status === 'failed')
        setNotice({ text: `A scan failed: ${event.message}` })
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return
    const box = menuElement.current.getBoundingClientRect()
    menuElement.current.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8))}px`
    menuElement.current.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8))}px`
  }, [menu])

  const addDisk = async () => {
    try {
      const added = await api.pickAndAddDisk()
      if (!added) return
      setDisks(await api.listDisks())
      await navigate({ diskId: added.id, tab: 'space' })
    } catch (error) {
      report(error)
    }
  }
  const cancelStaging = (diskId: number) => {
    for (const key of staging.current.keys()) if (key.startsWith(`${diskId}:`)) staging.current.delete(key)
  }
  const exclude = async (diskId: number, path: string) => {
    try {
      await api.addExclude(diskId, path)
      await refresh()
      setNotice({ text: `${path} is excluded.` })
    } catch (error) {
      report(error)
    }
  }
  const toggleDelete = async (diskId: number, item: { nodeId: number }) => {
    if (deletingRef.current) return
    const key = `${diskId}:${item.nodeId}`
    if (staging.current.has(key)) {
      staging.current.delete(key)
      return
    }
    if ((stagedByDisk[diskId] ?? []).some((entry) => entry.nodeId === item.nodeId)) {
      cancelStaging(diskId)
      setStagedByDisk((current) => ({
        ...current,
        [diskId]: (current[diskId] ?? []).filter((entry) => entry.nodeId !== item.nodeId),
      }))
      return
    }
    const action = Symbol()
    staging.current.set(key, action)
    try {
      const target = await api.stageDelete(diskId, item.nodeId)
      if (staging.current.get(key) !== action || deletingRef.current) return
      setStagedByDisk((current) => {
        const list = current[diskId] ?? []
        if (list.some((entry) => pathKey(entry.path) === pathKey(target.path))) return current
        return { ...current, [diskId]: [...list, target] }
      })
    } catch (error) {
      if (staging.current.get(key) === action) report(error)
    } finally {
      if (staging.current.get(key) === action) staging.current.delete(key)
    }
  }
  const removeStaged = (diskId: number, targetPath: string) => {
    cancelStaging(diskId)
    setStagedByDisk((current) => ({
      ...current,
      [diskId]: (current[diskId] ?? []).filter((entry) => !containsPath(targetPath, entry.path)),
    }))
  }
  const clearStaged = (diskId: number) => {
    cancelStaging(diskId)
    setStagedByDisk((current) => ({ ...current, [diskId]: [] }))
    setShowQueue(false)
  }
  const runStagedDelete = async (diskId: number) => {
    const items = stagedByDisk[diskId] ?? []
    if (!items.length || deletingRef.current || progress) return
    const summary = summarizeStaged(items)
    deletingRef.current = true
    staging.current.clear()
    setDeletingDisk(diskId)
    try {
      const result = await api.executeDelete(diskId, summary.top)
      const deletedKeys = new Set(result.deleted.map(pathKey))
      setStagedByDisk((current) => ({
        ...current,
        [diskId]: (current[diskId] ?? []).filter(
          (item) => ![...deletedKeys].some((delKey) => containsPath(delKey, item.path)),
        ),
      }))
      await refresh()
      if (result.failed.length > 0) {
        const first = result.failed[0]!
        setNotice({
          text: `Removed ${result.deleted.length} of ${summary.top.length} queued paths. Failed on ${first.path}: ${first.message} Saved scans remain unchanged; retry the remaining paths or scan again.`,
        })
      } else {
        if (intent.current?.diskId === diskId) setShowQueue(false)
        setNotice({
          text: `Removed ${result.deleted.length} queued ${result.deleted.length === 1 ? 'path' : 'paths'}. Saved scans remain unchanged. Scan again to capture current disk contents.`,
        })
      }
    } catch (error) {
      report(error)
    } finally {
      deletingRef.current = false
      setDeletingDisk(null)
    }
  }
  const applySettings = async (diskId: number, settings: HideSettings) => {
    setDisks((current) => current.map((disk) => (disk.id === diskId ? { ...disk, hides: settings } : disk)))
    const current = intent.current
    if (current?.diskId === diskId) await navigate(current)
  }
  const changeHides = async (diskId: number, change: HideChange) => {
    const identity = intent.current?.diskId === diskId ? ++request.current : null
    let result
    try {
      result = await api.changeHides(diskId, change)
    } catch (error) {
      if (identity === request.current) setNavigation({ status: 'ready' })
      throw error
    }
    await applySettings(diskId, result.settings)
    setNotice({
      text: change.type === 'metadata' ? 'Metadata visibility updated.' : 'Hidden paths updated.',
      undo: async () => {
        const identity = intent.current?.diskId === diskId ? ++request.current : null
        try {
          const settings = await api.undoHides(result.undo)
          await applySettings(diskId, settings)
          setNotice(null)
        } catch (error) {
          if (identity === request.current) setNavigation({ status: 'ready' })
          report(error)
        }
      },
    })
  }
  const context = (target: ContextTarget, event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!page || navigation.status === 'pending') return
    setMenu({
      owner: {
        diskId: page.disk.id,
        root: page.disk.root,
        page,
        request: request.current,
        action: ++hideAction.current,
      },
      target,
      origin: event.currentTarget as HTMLElement,
      x: event.clientX,
      y: event.clientY,
    })
  }
  const ownsHide = (owner: HideOwner) =>
    activePage.current === owner.page && intent.current?.diskId === owner.diskId && hideAction.current === owner.action
  const dismissMenu = () => {
    if (menu?.origin.isConnected) menu.origin.focus()
    setMenu(null)
  }
  const showFromMenu = async () => {
    if (!menu) return
    const { owner, target } = menu
    dismissMenu()
    if (!ownsHide(owner) || request.current !== owner.request) return
    try {
      const path = target.path ?? (await api.nodePath(target.nodeId))
      if (ownsHide(owner) && request.current === owner.request) await api.showInExplorer(path)
    } catch (error) {
      if (ownsHide(owner) && request.current === owner.request) report(error)
    }
  }
  const openHide = async () => {
    if (!menu) return
    const { owner, target } = menu
    dismissMenu()
    if (!ownsHide(owner) || request.current !== owner.request) return
    try {
      const path = target.path ?? (await api.nodePath(target.nodeId))
      if (ownsHide(owner) && request.current === owner.request) setDialog({ owner, path })
    } catch (error) {
      if (ownsHide(owner) && request.current === owner.request) report(error)
    }
  }
  const queueFromMenu = () => {
    if (!menu) return
    const { owner, target } = menu
    dismissMenu()
    if (!target.canDelete || !target.kind || !ownsHide(owner)) return
    void toggleDelete(owner.diskId, { nodeId: target.nodeId })
  }
  const excludeFromMenu = async () => {
    if (!menu) return
    const { owner, target } = menu
    dismissMenu()
    if (!target.kind || !ownsHide(owner) || request.current !== owner.request) return
    try {
      const path = target.path ?? (await api.nodePath(target.nodeId))
      await exclude(owner.diskId, path)
    } catch (error) {
      if (ownsHide(owner) && request.current === owner.request) report(error)
    }
  }
  const disk = page?.disk
  const staged = disk ? (stagedByDisk[disk.id] ?? []) : []
  const stagedSummary = summarizeStaged(staged)
  const staleQueue = staged.some((item) => item.scanId !== disk?.latestScan?.id)
  const complete = page?.scans.filter((scan) => scan.status === 'complete') ?? []
  return (
    <div className="app">
      <nav className="sidebar">
        <h1>Disk Watch</h1>
        {disks.length > 0 && (
          <ScanPanel
            disks={disks}
            progress={progress}
            deleting={deleting}
            elevated={elevated}
            onError={(text) => setNotice({ text })}
          />
        )}
        <ul className="disks">
          {disks.map((d) => (
            <li key={d.id}>
              <button
                className={d.id === disk?.id ? 'disk selected' : 'disk'}
                onClick={() => navigate({ diskId: d.id, tab: page?.tab ?? 'space' })}
              >
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
        {notice && (
          <div className="notice" role="status">
            <span>{notice.text}</span>
            {notice.undo && <button onClick={notice.undo}>Undo</button>}
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}
        {navigation.status === 'pending' && (
          <div className="loading-notice" role="status">
            Loading {navigation.intent.tab === 'changes' ? 'comparison' : 'view'}…
          </div>
        )}
        {navigation.status === 'error' && (
          <div className="notice" role="alert">
            <span>Could not load: {navigation.message}</span>
            <button onClick={() => navigate(navigation.intent)}>Retry</button>
          </div>
        )}
        {!page ? (
          disks.length === 0 ? (
            <div className="welcome">
              <h2>Find out where your disk space went</h2>
              <p>Pick the drives to track, then scan them. Scan again later to see what grew.</p>
              <button className="primary" onClick={addDisk}>
                Track a drive or folder
              </button>
            </div>
          ) : null
        ) : (
          <>
            <header className="disk-header">
              <h2>{page.disk.root}</h2>
            </header>
            {staged.length > 0 && (
              <section className="delete-summary" aria-label="Staged deletions">
                <div className="delete-summary-bar">
                  <span className="strong">
                    {stagedSummary.top.length} {stagedSummary.top.length === 1 ? 'item' : 'items'} staged for deletion
                  </span>
                  <span className="num strong danger-text">{formatBytes(stagedSummary.size)} estimated</span>
                  <button onClick={() => setShowQueue((open) => !open)}>{showQueue ? 'Hide list' : 'Review'}</button>
                  <button disabled={deleting} onClick={() => clearStaged(page.disk.id)}>
                    Clear
                  </button>
                  <button
                    className="danger"
                    disabled={deleting || progress !== null || staleQueue}
                    onClick={() => void runStagedDelete(page.disk.id)}
                  >
                    {deletingDisk === page.disk.id ? 'Deleting…' : 'Execute delete'}
                  </button>
                </div>
                <p className="muted small">
                  Permanent deletion. Estimate from the latest scan includes hidden files and uses logical sizes; actual
                  freed space can differ.{staleQueue && ' Scan changed. Remove and restage queued items.'}
                </p>
                {showQueue && (
                  <ul className="plain-list staged-list">
                    {stagedSummary.top.map((item) => (
                      <li key={item.path}>
                        <span className="path">{item.path}</span>
                        <span className="num muted">{formatBytes(item.size)}</span>
                        <button disabled={deleting} onClick={() => removeStaged(page.disk.id, item.path)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <div className="tabs" role="tablist">
              {(['space', 'changes', 'settings'] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={page.tab === tab}
                  className={page.tab === tab ? 'tab active' : 'tab'}
                  onClick={() => navigate({ ...intent.current!, diskId: page.disk.id, tab })}
                >
                  {{ space: 'Space', changes: 'Changes', settings: 'Settings' }[tab]}
                </button>
              ))}
            </div>
            {page.tab === 'settings' ? (
              <SettingsView
                key={page.disk.id}
                disk={page.disk}
                scans={page.scans}
                scanning={progress !== null || deleting}
                onChanged={refresh}
                onRemoved={() => {
                  clearStaged(page.disk.id)
                  void refresh()
                }}
                onHideChange={(change) => changeHides(page.disk.id, change)}
                onEditHide={(path) => {
                  if (navigation.status !== 'pending')
                    setDialog({
                      owner: {
                        diskId: page.disk.id,
                        root: page.disk.root,
                        page,
                        request: request.current,
                        action: ++hideAction.current,
                      },
                      path,
                      original: path,
                    })
                }}
                onError={report}
              />
            ) : complete.length === 0 ? (
              <p className="empty">No scans yet. Use Scan all drives to see what takes up the space.</p>
            ) : page.tab === 'space' ? (
              <SpaceView
                disk={page.disk}
                scans={complete}
                scanId={page.scanId!}
                rows={page.rows}
                total={page.total!}
                onPick={(scanId) => navigate({ diskId: page.disk.id, tab: 'space', scanId })}
                onContext={context}
                staged={staged}
              />
            ) : !page.comparison ? (
              <p className="empty">Changes compare two scans. Scan again later to see what came and went.</p>
            ) : (
              <ChangesView
                disk={page.disk}
                scans={complete}
                comparison={page.comparison}
                onPick={(field, scanId) => {
                  const current =
                    intent.current?.diskId === page.disk.id && intent.current.tab === 'changes' ? intent.current : null
                  void navigate({
                    diskId: page.disk.id,
                    tab: 'changes',
                    fromId: current?.fromId ?? page.comparison!.fromId,
                    toId: current?.toId ?? page.comparison!.toId,
                    [field === 'from' ? 'fromId' : 'toId']: scanId,
                  })
                }}
                onContext={context}
                staged={staged}
              />
            )}
          </>
        )}
      </main>
      {menu && (
        <div
          className="context-menu"
          ref={menuElement}
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              dismissMenu()
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
              const at = items.indexOf(document.activeElement as HTMLButtonElement)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
              items[next]?.focus()
            }
          }}
        >
          <button role="menuitem" autoFocus onClick={() => void showFromMenu()}>
            Show in Explorer
          </button>
          {menu.target.kind && (
            <button role="menuitem" onClick={openHide}>
              Hide…
            </button>
          )}
          {menu.target.kind && (
            <button role="menuitem" onClick={() => void excludeFromMenu()}>
              Exclude
            </button>
          )}
          {menu.target.canDelete && menu.target.kind && (
            <button role="menuitem" className="danger-quiet" onClick={queueFromMenu}>
              {staged.some((item) => item.nodeId === menu.target.nodeId)
                ? 'Remove from delete queue'
                : 'Queue for deletion'}
            </button>
          )}
        </div>
      )}
      {dialog && disk && ownsHide(dialog.owner) && (
        <HideDialog
          key={dialog.owner.action}
          root={dialog.owner.root}
          path={dialog.path}
          editing={!!dialog.original}
          onSave={(path) => {
            if (!ownsHide(dialog.owner)) return Promise.reject(new Error('This view changed. Open Hide again.'))
            return changeHides(
              dialog.owner.diskId,
              dialog.original ? { type: 'replace', path: dialog.original, replacement: path } : { type: 'add', path },
            )
          }}
          onClose={() => setDialog((current) => (current === dialog ? null : current))}
        />
      )}
    </div>
  )
}

interface ScanPanelProps {
  disks: Disk[]
  progress: ScanProgress | null
  elevated: boolean
  deleting: boolean
  onError(text: string): void
}

function ScanPanel({ disks, progress, elevated, deleting, onError }: ScanPanelProps) {
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
      <button
        className="primary"
        disabled={deleting}
        onClick={() => api.startScan().catch((err: Error) => onError(err.message))}
      >
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
