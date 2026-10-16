import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type {
  Disk,
  NodeKind,
  ScanSummary,
  SearchResult,
  SearchRow,
  StagedDelete,
  TreeRow,
  ViewTotal,
} from '../../shared/types'
import { api, formatBytes, formatCount, isWindows } from './api'
import { BulkQueueDialog } from './BulkQueueDialog'
import { errorText, planBulkQueue, type BulkOutcome, type BulkPlan } from './bulkQueue'
import { FilteredList } from './FilteredList'
import { LazyTree } from './LazyTree'
import { NodeCells } from './NodeCells'
import { NodeIcon } from './NodeIcon'
import { ScanPicker } from './ScanPicker'
import { ScanDiagnostics } from './ScanDiagnostics'
import { emptySelection, pruneSelection, type Selection } from './selection'

const DEBOUNCE_MS = 250

interface SpaceViewProps {
  disk: Disk
  scans: ScanSummary[]
  staged: StagedDelete[]
  scanId: number
  rows: TreeRow[]
  total: ViewTotal
  /** Why this root cannot queue deletions now, or null when it can. */
  queueBlocked: string | null
  onQueueMany(rows: SearchRow[], signal: AbortSignal, onProgress: (done: number) => void): Promise<BulkOutcome>
  onChooseDrive(): void
  onPick(scanId: number): void
  onContext(
    target: {
      nodeId: number
      path?: string
      kind?: Exclude<NodeKind, 'rest'>
      size?: number
      files?: number
      canDelete?: boolean
    },
    event: MouseEvent,
  ): void
}

export interface Filters {
  name: string
  days: string
}

/** Filter text as typed becomes a query only when it can match something. */
export function filterQuery(filters: Filters): { nameContains?: string; olderThanDays?: number } | null {
  const days = filters.days.trim() === '' ? undefined : Number(filters.days)
  const olderThanDays = days !== undefined && Number.isFinite(days) && days >= 0 ? days : undefined
  const nameContains = filters.name === '' ? undefined : filters.name
  return nameContains === undefined && olderThanDays === undefined ? null : { nameContains, olderThanDays }
}

/** Inline message for an age the filter cannot use, or null. */
export function ageProblem(days: string): string | null {
  if (days.trim() === '') return null
  const value = Number(days)
  return Number.isFinite(value) && value >= 0 ? null : 'Enter 0 or more days'
}

export function matchSummary(result: Pick<SearchResult, 'rows' | 'total'>): string {
  if (result.total > result.rows.length)
    return `Showing the largest ${formatCount(result.rows.length)} of ${formatCount(result.total)} matches`
  return `${formatCount(result.total)} ${result.total === 1 ? 'match' : 'matches'}`
}

export function SpaceView({
  disk,
  scans,
  scanId,
  rows,
  total,
  onPick,
  onContext,
  staged,
  onChooseDrive,
  queueBlocked,
  onQueueMany,
}: SpaceViewProps) {
  const scan = scans.find((s) => s.id === scanId)!
  const revision = disk.hides.revision
  const stagedIds = useMemo(() => new Set(staged.map((item) => item.nodeId)), [staged])
  const [sort, setSort] = useState<'size' | 'written'>('size')
  const [filters, setFilters] = useState<Filters>({ name: '', days: '' })
  const [query, setQuery] = useState(() => filterQuery(filters))
  const [result, setResult] = useState<(SearchResult & { key: string }) | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [plan, setPlan] = useState<(BulkPlan & { id: number }) | null>(null)
  const order = useCallback(
    (items: TreeRow[]) =>
      [...items].sort((a, b) =>
        sort === 'written' ? (b.lastWrittenAt ?? 0) - (a.lastWrittenAt ?? 0) || b.size - a.size : b.size - a.size,
      ),
    [sort],
  )
  const load = useCallback(
    async (nodeId: number) => order(await api.children(scan.id, nodeId, revision)),
    [scan.id, revision, order],
  )

  useEffect(() => {
    const timer = setTimeout(() => setQuery(filterQuery(filters)), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters])

  const searchKey = query ? `${scan.id}-${revision}-${JSON.stringify(query)}` : null
  useEffect(() => {
    if (!query || !searchKey) return
    let live = true
    setSearchError(null)
    api.search(scan.id, { ...query, now: Date.now(), revision }).then(
      (found) => {
        if (!live) return
        setResult({ ...found, key: searchKey })
        setSelection((current) =>
          pruneSelection(
            current,
            found.rows.map((row) => row.nodeId),
          ),
        )
      },
      (error: unknown) => live && setSearchError(errorText(error)),
    )
    return () => {
      live = false
    }
  }, [scan.id, revision, query, searchKey, attempt])

  const active = filterQuery(filters) !== null || query !== null
  const matches = useMemo(() => (active && result ? (order(result.rows) as SearchRow[]) : []), [active, result, order])
  const selected = matches.filter((row) => selection.ids.has(row.nodeId))
  const selectedSize = selected.reduce((sum, row) => sum + row.size, 0)
  const clear = () => {
    setFilters({ name: '', days: '' })
    setQuery(null)
    setResult(null)
    setSelection(emptySelection)
  }

  const renderRow = useCallback(
    (row: TreeRow, siblings: TreeRow[]) => {
      const parentSize = siblings.reduce((sum, s) => sum + s.size, 0)
      const isStaged = stagedIds.has(row.nodeId)
      return {
        name: (
          <span className={`name kind-${row.kind}${isStaged ? ' staged-row' : ''}`}>
            {row.kind !== 'rest' && <NodeIcon kind={row.kind} />}
            <span className="node-name">{row.name}</span>
            {isStaged && <span className="tag staged">queued</span>}
          </span>
        ),
        cells: (
          <NodeCells row={row} share={parentSize > 0 ? row.size / parentSize : 0} shareLabel="of the folder above" />
        ),
      }
    },
    [stagedIds],
  )
  const context = (row: TreeRow, event: MouseEvent, pathDepth: number) => {
    if (row.kind !== 'rest')
      onContext(
        { nodeId: row.nodeId, kind: row.kind, size: row.size, files: row.files, canDelete: pathDepth >= 2 },
        event,
      )
  }
  const agePrompt = ageProblem(filters.days)

  return (
    <div className="view">
      <div className="view-bar">
        <ScanPicker label="Scan" scans={scans} value={scan.id} onChange={onPick} />
        <span className="strong">{formatBytes(total.visible.size)} visible</span>
        <span className="muted">
          {formatBytes(total.raw.size)} captured · {formatBytes(total.hidden.size)} hidden ·{' '}
          {formatCount(total.visible.files)} visible files
          {scan.errors > 0 && ` · ${formatCount(scan.errors)} items could not be read`}
        </span>
      </div>
      <ScanDiagnostics key={scan.id} scan={scan} unix={!isWindows(disk)} onChooseDrive={onChooseDrive} />
      {active && (
        <div className="filter-status">
          {searchError ? (
            <span>
              Could not search: {searchError} <button onClick={() => setAttempt(attempt + 1)}>Retry</button>
            </span>
          ) : (
            <span className="muted small" role="status">
              {!result || result.key !== searchKey ? 'Searching…' : matchSummary(result)}
              {filters.name !== '' && ' · Files grouped as smaller files cannot be found by name'}
            </span>
          )}
          {selected.length > 0 && (
            <span className="selection-bar">
              <span className="strong">
                {formatCount(selected.length)} selected · {formatBytes(selectedSize)}
              </span>
              <button
                className="danger"
                onClick={() =>
                  setPlan({
                    ...planBulkQueue(selected, staged, queueBlocked, isWindows(disk)),
                    id: (plan?.id ?? 0) + 1,
                  })
                }
              >
                Queue for deletion…
              </button>
              <button onClick={() => setSelection(emptySelection)}>Clear selection</button>
            </span>
          )}
        </div>
      )}
      <div className="columns space-columns">
        <span>Name</span>
        <button className="column-sort num" onClick={() => setSort('size')} aria-pressed={sort === 'size'}>
          Size{sort === 'size' ? ' ↓' : ''}
        </button>
        <span className="num">Files</span>
        <button
          className="column-sort age-heading"
          onClick={() => setSort('written')}
          aria-pressed={sort === 'written'}
        >
          Age{sort === 'written' ? ' ↓' : ''}
        </button>
        <div className="column-filter name-filter">
          <input
            type="search"
            aria-label="Name contains"
            placeholder="Name contains…"
            value={filters.name}
            spellCheck={false}
            onChange={(event) => setFilters({ ...filters, name: event.target.value })}
          />
          {active && <button onClick={clear}>Clear</button>}
        </div>
        <span />
        <span />
        <label className="column-filter age-filter">
          older than
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label="Last written more than this many days ago"
            aria-invalid={agePrompt !== null}
            aria-describedby={agePrompt ? 'age-problem' : undefined}
            value={filters.days}
            onChange={(event) => setFilters({ ...filters, days: event.target.value })}
          />
          days
          {agePrompt && (
            <span id="age-problem" className="filter-problem" role="alert">
              {agePrompt}
            </span>
          )}
        </label>
      </div>
      {active ? (
        result?.key === searchKey && matches.length === 0 ? (
          <div className="tree">
            <div className="tree-note filter-empty">No matches in this scan.</div>
          </div>
        ) : (
          <FilteredList
            rows={matches}
            visibleSize={total.visible.size}
            stagedIds={stagedIds}
            selection={selection}
            onSelect={setSelection}
            reloadKey={`${scan.id}-${revision}-${sort}`}
            load={load}
            renderChild={renderRow}
            onContextMenu={context}
          />
        )
      ) : (
        <LazyTree<TreeRow>
          reloadKey={`${scan.id}-${revision}-${sort}`}
          rootId={disk.rootNode}
          rootRows={order(rows)}
          onContextMenu={(row, event, depth) => context(row, event, depth + 1)}
          load={load}
          rowId={(row) => row.nodeId}
          canExpand={(row) => row.kind === 'dir'}
          emptyText={
            scan.coverage === 'partial'
              ? 'No captured entries in this partial scan'
              : scan.files === 0 && (scan.skipped?.mounts ?? 0) > 0
                ? 'No files captured within this mount scope'
                : 'Empty folder'
          }
          renderRow={renderRow}
        />
      )}
      {plan && (
        <BulkQueueDialog
          key={plan.id}
          plan={plan}
          onQueue={async (queue, signal, onProgress) => {
            const outcome = await onQueueMany(queue, signal, onProgress)
            if (outcome.queued) setSelection(emptySelection)
            return outcome
          }}
          onClose={() => setPlan(null)}
        />
      )}
    </div>
  )
}
