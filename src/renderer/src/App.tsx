import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import type {
  Comparison,
  DeleteResult,
  DeleteOperation,
  Disk,
  DiskSnapshot,
  HideChange,
  HideSettings,
  NodeKind,
  SearchRow,
  ScanProgress,
  StagedDelete,
  TreeRow,
  ViewTotal,
} from '../../shared/types'
import { api, formatBytes, formatCount, formatWhen, isWindows, isHistorical, canCleanup, machineLabel } from './api'
import { ChangesView } from './ChangesView'
import { DeleteFailureDialog } from './DeleteFailureDialog'
import { HideDialog } from './HideDialog'
import { SettingsView } from './SettingsView'
import { SpaceView } from './SpaceView'
import { TreemapView } from './TreemapView'
import { VolumeChooser } from './VolumeChooser'
import { sameTarget, containsTarget, summarizeStaged, verifiedScanTime } from './deleteQueue'
import { errorText, LIMIT_REASON, QUEUE_LIMIT, type BulkOutcome, type SkippedItem } from './bulkQueue'

type Tab = 'space' | 'treemap' | 'changes' | 'settings'
interface Intent {
  diskId: number
  tab: Tab
  scanId?: number
  fromId?: number
  toId?: number
}
type Page = DiskSnapshot &
  (
    | { tab: 'space' | 'treemap'; scanId: number | null; rows: TreeRow[]; total: ViewTotal | null }
    | { tab: 'changes'; comparison: Comparison | null }
    | { tab: 'settings' }
  )
type Navigation =
  { status: 'ready' } | { status: 'pending'; intent: Intent } | { status: 'error'; intent: Intent; message: string }
interface Notice {
  text: string
  undo?: () => void
  details?: () => void
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
  components?: string[]
  kind?: Exclude<NodeKind, 'rest'>
  size?: number
  files?: number
  canDelete?: boolean
}

export function App() {
  const [chooser, setChooser] = useState<{ source: 'local' | 'ssh'; destination?: string } | null>(null)
  const [verifiedScans, setVerifiedScans] = useState<Record<number, number>>({})
  const [operations, setOperations] = useState<Record<number, DeleteOperation[]>>({})
  const [recovering, setRecovering] = useState<string | null>(null)
  const [disks, setDisks] = useState<Disk[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [navigation, setNavigation] = useState<Navigation>({ status: 'ready' })
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [deleteFailure, setDeleteFailure] = useState<DeleteResult | null>(null)
  const [elevated, setElevated] = useState(true)
  const [stagedByDisk, setStagedByDisk] = useState<Record<number, StagedDelete[]>>({})
  const stagedRef = useRef(stagedByDisk)
  stagedRef.current = stagedByDisk
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
  const [dialog, setDialog] = useState<{
    owner: HideOwner
    path: string
    components?: string[]
    original?: string
    originalComponents?: string[]
  } | null>(null)
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
      if (!isWindows(snapshot.disk)) {
        const pending = await api.deleteOperations(next.diskId)
        if (identity !== request.current) return
        setOperations((current) => ({
          ...current,
          [next.diskId]: pending.filter((operation) => operation.state !== 'completed'),
        }))
        setVerifiedScans((current) => ({ ...current, [next.diskId]: verifiedScanTime(scans) }))
      }
      const revision = snapshot.disk.hides.revision
      let prepared: Page
      if (next.tab === 'settings') prepared = { ...snapshot, tab: 'settings' }
      else if (next.tab === 'space' || next.tab === 'treemap') {
        const scan = scans.find((scan) => scan.id === next.scanId) ?? scans[0]
        const [rows, total] = scan
          ? await Promise.all([api.children(scan.id, snapshot.disk.rootNode, revision), api.totals(scan.id, revision)])
          : [[], null]
        prepared = { ...snapshot, tab: next.tab, scanId: scan?.id ?? null, rows, total }
      } else {
        let comparison: Comparison | null = null
        const comparable = scans.filter((scan) => scan.coverage !== 'partial')
        if (comparable.length >= 2) {
          const a = comparable.find((scan) => scan.id === next.fromId) ?? comparable[1]!
          const b = comparable.find((scan) => scan.id === next.toId) ?? comparable[0]!
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
    if (navigator.platform.startsWith('Win')) api.isElevated().then(setElevated).catch(report)
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

  const addDisk = () => setChooser({ source: 'local' })

  const cancelStaging = (diskId: number) => {
    for (const key of staging.current.keys()) if (key.startsWith(`${diskId}:`)) staging.current.delete(key)
  }
  const exclude = async (diskId: number, nodeId: number) => {
    try {
      const path = await api.addExcludeNode(diskId, nodeId)
      await refresh()
      setNotice({ text: `${path} is excluded.` })
    } catch (error) {
      report(error)
    }
  }
  const needsRecovery = (diskId: number) =>
    operations[diskId] === undefined ||
    operations[diskId]!.some((operation) => operation.createdAt >= (verifiedScans[diskId] ?? 0))
  const toggleDelete = async (diskId: number, item: { nodeId: number }) => {
    const owner = disks.find((disk) => disk.id === diskId)
    if (deletingRef.current || !owner || !canCleanup(owner) || (!isWindows(owner) && needsRecovery(diskId))) return
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
        if (list.some((entry) => sameTarget(entry, target))) return current
        return { ...current, [diskId]: [...list, target] }
      })
    } catch (error) {
      if (staging.current.get(key) === action) report(error)
    } finally {
      if (staging.current.get(key) === action) staging.current.delete(key)
    }
  }
  const queueBlocked = (diskId: number): string | null => {
    const owner = disks.find((disk) => disk.id === diskId)
    if (!owner) return 'This root is no longer tracked.'
    if (isHistorical(owner)) return 'Saved history cannot delete files.'
    if (!canCleanup(owner)) return 'Deletion is off for this root. Turn it on in Settings.'
    if (!isWindows(owner) && needsRecovery(diskId))
      return 'An earlier deletion needs a status check and a fresh scan first.'
    if (deleting || deletingRef.current) return 'A deletion is running.'
    return null
  }
  /**
   * Adds staged targets without removing anything already queued, a few requests at a time.
   * Navigation, Clear and Execute delete cancel the remaining requests, as for single items.
   */
  const queueMany = async (
    diskId: number,
    rows: SearchRow[],
    signal: AbortSignal,
    onProgress: (done: number) => void,
  ): Promise<BulkOutcome> => {
    const blocked = queueBlocked(diskId)
    if (blocked)
      return { queued: 0, skipped: rows.map((row) => ({ nodeId: row.nodeId, path: row.path, reason: blocked })) }
    const key = `${diskId}:bulk`
    const action = Symbol()
    staging.current.set(key, action)
    const live = () => staging.current.get(key) === action && !deletingRef.current && !signal.aborted
    let list = [...(stagedRef.current[diskId] ?? [])]
    const skipped: SkippedItem[] = []
    const pending = [...rows]
    let queued = 0
    let done = 0
    const next = async () => {
      for (let row = pending.shift(); row; row = pending.shift()) {
        const skip = (reason: string) => skipped.push({ nodeId: row!.nodeId, path: row!.path, reason })
        if (!live()) {
          skip('Stopped before this item was queued.')
          continue
        }
        try {
          const target = await api.stageDelete(diskId, row.nodeId)
          const holder = list.find((entry) => containsTarget(entry, target))
          if (!live()) skip('Stopped before this item was queued.')
          else if (holder)
            skip(sameTarget(holder, target) ? 'Already queued.' : `Already queued inside ${holder.path}.`)
          else if (summarizeStaged([...list, target]).top.length > QUEUE_LIMIT) skip(LIMIT_REASON)
          else {
            list = [...list, target]
            queued++
            setStagedByDisk((current) => {
              const items = current[diskId] ?? []
              if (items.some((entry) => sameTarget(entry, target))) return current
              return { ...current, [diskId]: [...items, target] }
            })
          }
        } catch (error) {
          skip(errorText(error))
        }
        onProgress(++done)
      }
    }
    try {
      await Promise.all([next(), next(), next(), next()])
    } finally {
      if (staging.current.get(key) === action) staging.current.delete(key)
    }
    return { queued, skipped }
  }
  const removeStaged = (diskId: number, target: StagedDelete) => {
    cancelStaging(diskId)
    setStagedByDisk((current) => ({
      ...current,
      [diskId]: (current[diskId] ?? []).filter((entry) => !containsTarget(target, entry)),
    }))
  }
  const clearStaged = (diskId: number) => {
    cancelStaging(diskId)
    setStagedByDisk((current) => ({ ...current, [diskId]: [] }))
    setShowQueue(false)
  }
  const runStagedDelete = async (diskId: number) => {
    const items = stagedByDisk[diskId] ?? []
    const owner = disks.find((disk) => disk.id === diskId)
    if (
      !items.length ||
      deletingRef.current ||
      progress ||
      !owner ||
      !canCleanup(owner) ||
      (!isWindows(owner) && needsRecovery(diskId))
    )
      return
    const summary = summarizeStaged(items)
    deletingRef.current = true
    staging.current.clear()
    setDeletingDisk(diskId)
    if (!isWindows(owner))
      setOperations((current) => {
        const next = { ...current }
        delete next[diskId]
        return next
      })
    try {
      const result = await api.executeDelete(diskId, summary.top)
      if (result.state && result.state !== 'completed') {
        await refresh()
        setNotice({ text: 'Deletion status is uncertain. Check status, then scan again and restage unresolved items.' })
        return
      }
      const removed = summary.top.filter((target) => result.deleted.includes(target.path))
      setStagedByDisk((current) => ({
        ...current,
        [diskId]: (current[diskId] ?? []).filter((item) => !removed.some((target) => containsTarget(target, item))),
      }))
      await refresh()
      if (result.failed.length > 0) {
        setDeleteFailure(result)
        setNotice({
          text: `Removed ${result.deleted.length} of ${summary.top.length} queued paths. ${result.failed.length} failed. Saved scans remain unchanged; retry the remaining paths or scan again.`,
          details: () => setDeleteFailure(result),
        })
      } else {
        if (intent.current?.diskId === diskId) setShowQueue(false)
        setNotice({
          text: `Removed ${result.deleted.length} queued ${result.deleted.length === 1 ? 'path' : 'paths'}. Saved scans remain unchanged. Scan again to capture current disk contents.`,
        })
      }
    } catch (error) {
      await refresh()
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
      if (ownsHide(owner) && request.current === owner.request) await api.showNode(owner.diskId, target.nodeId)
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
      const location = await api.nodeLocation(target.nodeId)
      if (location.diskId !== owner.diskId) throw new Error('This path belongs to another tracked root.')
      if (ownsHide(owner) && request.current === owner.request)
        setDialog({
          owner,
          path: location.path,
          components: isWindows(owner.page.disk) ? undefined : location.components,
        })
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
      await exclude(owner.diskId, target.nodeId)
    } catch (error) {
      if (ownsHide(owner) && request.current === owner.request) report(error)
    }
  }
  const disk = page?.disk
  const staged = disk ? (stagedByDisk[disk.id] ?? []) : []
  const unresolved = disk && !isWindows(disk) ? (operations[disk.id] ?? []) : []
  const deletionBlocked = !disk || !canCleanup(disk) || (disk && !isWindows(disk) && needsRecovery(disk.id))
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
                <span className="muted small">
                  {machineLabel(d)}
                  {isHistorical(d) ? ' · saved history' : ''}
                </span>
                {d.capacity && (
                  <span
                    className="capacity"
                    title={`${formatBytes(d.capacity.free)} free of ${formatBytes(d.capacity.total)}${d.nativeRoot ? ` · observed ${formatWhen(d.nativeRoot.observedAt)}, may be stale` : ''}`}
                  >
                    <span style={{ width: `${(1 - d.capacity.free / d.capacity.total) * 100}%` }} />
                  </span>
                )}
                <span className="muted small">
                  {d.capacity
                    ? `${formatBytes(d.capacity.free)} free${d.nativeRoot ? ' at last observation' : ''} · `
                    : ''}
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
        <button className="add-disk" onClick={() => setChooser({ source: 'ssh' })}>
          Track over SSH
        </button>
      </nav>
      <main>
        {notice && (
          <div className="notice" role="status">
            <span>{notice.text}</span>
            {notice.undo && <button onClick={notice.undo}>Undo</button>}
            {notice.details && <button onClick={notice.details}>View details</button>}
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
              <span className="muted small">
                {machineLabel(page.disk)}
                {isHistorical(page.disk) ? ' · saved history, file actions unavailable' : ''}
              </span>
            </header>
            {unresolved.length > 0 && (
              <section className="delete-summary" aria-label="Deletion status">
                <p>Files may already have been removed. Check status, then scan again and restage unresolved items.</p>
                <ul className="plain-list">
                  {unresolved.map((operation) => (
                    <li key={operation.operationId}>
                      <span>
                        {formatWhen(operation.createdAt)} · {operation.state}
                      </span>
                      <button
                        disabled={recovering !== null || deleting || isHistorical(page.disk)}
                        onClick={async () => {
                          setRecovering(operation.operationId)
                          try {
                            const result = await api.recoverDelete(operation.operationId)
                            if (result.failed.length) setDeleteFailure(result)
                            if (result.state === 'completed')
                              setStagedByDisk((current) => {
                                const items = current[page.disk.id] ?? []
                                const removed = items.filter((item) => result.deleted.includes(item.path))
                                return {
                                  ...current,
                                  [page.disk.id]: items.filter(
                                    (item) => !removed.some((target) => containsTarget(target, item)),
                                  ),
                                }
                              })
                            await refresh()
                            setNotice({
                              text:
                                result.state === 'completed'
                                  ? 'Deletion status checked. Scan again and restage any remaining paths before deleting.'
                                  : 'Deletion status is unresolved. Scan again and restage remaining paths before deleting.',
                            })
                          } catch (error) {
                            report(error)
                          } finally {
                            setRecovering(null)
                          }
                        }}
                      >
                        {recovering === operation.operationId ? 'Checking…' : 'Check deletion status'}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
                    disabled={deleting || progress !== null || staleQueue || deletionBlocked}
                    onClick={() => void runStagedDelete(page.disk.id)}
                  >
                    {deletingDisk === page.disk.id ? 'Deleting…' : 'Execute delete'}
                  </button>
                </div>
                <p className="muted small">
                  Permanent deletion. Estimate from the latest scan includes hidden files and uses logical sizes; actual
                  freed space can differ.
                  {stagedSummary.partial && ' Some items were queued from a partial scan, so freed space may differ.'}
                  {staleQueue && ' Scan changed. Remove and restage queued items.'}
                </p>
                {showQueue && (
                  <ul className="plain-list staged-list">
                    {stagedSummary.top.map((item) => (
                      <li key={item.path}>
                        <span className="path">{item.path}</span>
                        <span className="num muted">{formatBytes(item.size)}</span>
                        <button disabled={deleting} onClick={() => removeStaged(page.disk.id, item)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <div className="tabs" role="tablist">
              {(['space', 'treemap', 'changes', 'settings'] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={page.tab === tab}
                  className={page.tab === tab ? 'tab active' : 'tab'}
                  onClick={() => navigate({ ...intent.current!, diskId: page.disk.id, tab })}
                >
                  {{ space: 'Space', treemap: 'Treemap', changes: 'Changes', settings: 'Settings' }[tab]}
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
                onReinspected={() => {
                  clearStaged(page.disk.id)
                  void refresh()
                }}
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
                      components: page.disk.hides.rules?.find((rule) => rule.path === path)?.components,
                      originalComponents: page.disk.hides.rules?.find((rule) => rule.path === path)?.components,
                    })
                }}
                onError={report}
              />
            ) : complete.length === 0 ? (
              <p className="empty">No scans yet. Use Scan all drives to see what takes up the space.</p>
            ) : page.tab === 'space' ? (
              <SpaceView
                key={page.disk.id}
                queueBlocked={queueBlocked(page.disk.id)}
                onQueueMany={(rows, signal, onProgress) => queueMany(page.disk.id, rows, signal, onProgress)}
                disk={page.disk}
                scans={complete}
                scanId={page.scanId!}
                rows={page.rows}
                total={page.total!}
                onPick={(scanId) => navigate({ diskId: page.disk.id, tab: 'space', scanId })}
                onContext={context}
                staged={staged}
                onChooseDrive={() =>
                  setChooser({
                    source: page.disk.machine?.kind === 'ssh' ? 'ssh' : 'local',
                    destination: page.disk.machine?.destination,
                  })
                }
              />
            ) : page.tab === 'treemap' ? (
              <TreemapView
                key={`${page.disk.id}-${page.scanId}-${page.disk.hides.revision}`}
                disk={page.disk}
                scans={complete}
                scanId={page.scanId!}
                rows={page.rows}
                total={page.total!}
                onPick={(scanId) => navigate({ diskId: page.disk.id, tab: 'treemap', scanId })}
                onContext={context}
                staged={staged}
                onChooseDrive={() =>
                  setChooser({
                    source: page.disk.machine?.kind === 'ssh' ? 'ssh' : 'local',
                    destination: page.disk.machine?.destination,
                  })
                }
              />
            ) : !('comparison' in page) || !page.comparison ? (
              <p className="empty">
                Changes needs two scans with complete coverage. Partial scans remain available in Space and Treemap.
              </p>
            ) : (
              <ChangesView
                disk={page.disk}
                scans={complete.filter((scan) => scan.coverage !== 'partial')}
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
            {isHistorical(menu.owner.page.disk) || menu.owner.page.disk.machine?.kind === 'ssh'
              ? 'Copy path'
              : isWindows(menu.owner.page.disk)
                ? 'Show in Explorer'
                : 'Show in Finder'}
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
          {menu.target.canDelete &&
            menu.target.kind &&
            canCleanup(menu.owner.page.disk) &&
            (isWindows(menu.owner.page.disk) || !needsRecovery(menu.owner.diskId)) && (
              <button role="menuitem" className="danger-quiet" onClick={queueFromMenu}>
                {staged.some((item) => item.nodeId === menu.target.nodeId)
                  ? 'Remove from delete queue'
                  : 'Queue for deletion'}
              </button>
            )}
        </div>
      )}
      {chooser && (
        <VolumeChooser
          initialSource={chooser.source}
          initialDestination={chooser.destination}
          onClose={() => setChooser(null)}
          onTracked={async (added) => {
            setDisks(await api.listDisks())
            await navigate({ diskId: added.id, tab: 'space' })
          }}
        />
      )}

      {deleteFailure && <DeleteFailureDialog result={deleteFailure} onClose={() => setDeleteFailure(null)} />}
      {dialog && disk && ownsHide(dialog.owner) && (
        <HideDialog
          key={dialog.owner.action}
          root={dialog.owner.root}
          path={dialog.path}
          components={dialog.components}
          unix={!isWindows(dialog.owner.page.disk)}
          editing={!!dialog.original}
          onSave={(path, components) => {
            if (!ownsHide(dialog.owner)) return Promise.reject(new Error('This view changed. Open Hide again.'))
            return changeHides(
              dialog.owner.diskId,
              dialog.original
                ? {
                    type: 'replace',
                    path: dialog.original,
                    components: dialog.originalComponents,
                    replacement: path,
                    replacementComponents: components,
                  }
                : { type: 'add', path, components },
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
        disabled={deleting || disks.every(isHistorical)}
        onClick={() => api.startScan().catch((err: Error) => onError(err.message))}
      >
        Scan all drives
      </button>
      {disks.some(
        (disk) =>
          disk.machine?.kind === 'local' && disk.machine.os === 'macos' && disk.nativeRoot?.filesystem === 'apfs',
      ) && (
        <button
          disabled={deleting}
          title="Reuses unchanged Mac folders. The first quick scan builds a baseline; other drives receive a full scan. Use Scan all drives to read every folder again."
          onClick={() => api.startScan('incremental').catch((err: Error) => onError(err.message))}
        >
          Quick scan (experimental)
        </button>
      )}
      {!elevated &&
        navigator.platform.startsWith('Win') &&
        disks.some((disk) => isWindows(disk) && disk.machine?.kind !== 'ssh' && !isHistorical(disk)) && (
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
