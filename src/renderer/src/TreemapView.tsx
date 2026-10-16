import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { Disk, NodeKind, ScanSummary, StagedDelete, TreeRow, ViewTotal } from '../../shared/types'
import { api, formatBytes, formatCount, joinDisplayPath, isWindows } from './api'
import { openRowContext } from './rowContext'
import { ScanPicker } from './ScanPicker'
import { ScanDiagnostics } from './ScanDiagnostics'
import { mapEntries, treemap, type MapEntry, type Rectangle } from './treemap'
import { errorText } from './bulkQueue'

interface Props {
  disk: Disk
  scans: ScanSummary[]
  scanId: number
  rows: TreeRow[]
  total: ViewTotal
  staged: StagedDelete[]
  onChooseDrive(): void
  onPick(scanId: number): void
  onContext(
    target: { nodeId: number; kind?: Exclude<NodeKind, 'rest'>; size?: number; files?: number; canDelete?: boolean },
    event: MouseEvent,
  ): void
}
interface Location {
  name: string
  nodeId: number
  rows: TreeRow[]
  depth: number
}

function position(box: Rectangle<MapEntry>): CSSProperties {
  return { left: box.x, top: box.y, width: box.width, height: box.height }
}

export function TreemapView({ disk, scans, scanId, rows, total, staged, onPick, onContext, onChooseDrive }: Props) {
  const scan = scans.find((item) => item.id === scanId)!
  const [trail, setTrail] = useState<Location[]>([{ name: disk.root, nodeId: disk.rootNode, rows, depth: 0 }])
  const location = trail.at(-1)!
  const [children, setChildren] = useState<Map<number, TreeRow[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ message: string; entry: MapEntry; parent?: MapEntry } | null>(null)
  const [detail, setDetail] = useState<{ entry: MapEntry; path: string } | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const canvas = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const cache = useRef(new Map<number, TreeRow[]>())
  const stagedIds = new Set(staged.map((item) => item.nodeId))
  const boxes = useMemo(() => treemap(mapEntries(location.rows), bounds.width, bounds.height), [location, bounds])
  const size = location.rows.reduce((sum, row) => sum + row.size, 0)
  const path = trail
    .filter((part, i) => i === 0 || part.depth !== trail[i - 1]!.depth)
    .reduce((value, part, i) => (i === 0 ? part.name : joinDisplayPath(disk, value, part.name)), '')

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    if (canvas.current) observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      ++request.current
    },
    [],
  )

  useEffect(() => {
    let active = true
    const candidates = boxes
      .filter((box) => box.item.row?.kind === 'dir' && box.width >= 100 && box.height >= 85)
      .slice(0, 16)
    void (async () => {
      for (let at = 0; at < candidates.length; at += 4) {
        await Promise.all(
          candidates.slice(at, at + 4).map(async ({ item }) => {
            const id = item.row!.nodeId
            try {
              const found = cache.current.get(id) ?? (await api.children(scanId, id, disk.hides.revision))
              if (!active) return
              cache.current.set(id, found)
              setChildren((current) => new Map(current).set(id, found))
            } catch {
              /* The folder remains available for an explicit retry by opening it. */
            }
          }),
        )
        if (!active) return
      }
    })()
    return () => {
      active = false
    }
  }, [boxes, scanId, disk.hides.revision])

  async function open(entry: MapEntry, parent?: MapEntry) {
    if (!entry.grouped && entry.row?.kind !== 'dir') return
    const identity = ++request.current
    setLoading(true)
    setError(null)
    try {
      const found =
        entry.grouped ??
        cache.current.get(entry.row!.nodeId) ??
        (await api.children(scanId, entry.row!.nodeId, disk.hides.revision))
      if (identity !== request.current) return
      if (entry.row) cache.current.set(entry.row.nodeId, found)
      const ancestors: Location[] = parent
        ? [
            {
              name: parent.name,
              nodeId: parent.row!.nodeId,
              rows: cache.current.get(parent.row!.nodeId)!,
              depth: location.depth + 1,
            },
          ]
        : []
      setTrail((current) => [
        ...current,
        ...ancestors,
        {
          name: entry.name,
          nodeId: entry.row?.nodeId ?? parent?.row?.nodeId ?? location.nodeId,
          rows: found,
          depth: location.depth + ancestors.length + (entry.grouped ? 0 : 1),
        },
      ])
      setDetail(null)
    } catch (err) {
      if (identity === request.current) setError({ message: errorText(err), entry, parent })
    } finally {
      if (identity === request.current) setLoading(false)
    }
  }

  function tile(box: Rectangle<MapEntry>, color: number, depth: number, parentPath: string, parent?: MapEntry) {
    const { item } = box
    const row = item.row
    const interactive = !!item.grouped || row?.kind !== 'rest'
    const fullPath = joinDisplayPath(disk, parentPath, item.name)
    const nestedRows = !parent && row?.kind === 'dir' ? children.get(row.nodeId) : undefined
    const inset = nestedRows && box.width >= 100 && box.height >= 85
    const isStaged = !!row && stagedIds.has(row.nodeId)
    const content = (
      <>
        {box.width > 48 && box.height > 40 && (
          <span className="map-name">
            {item.name}
            {isStaged ? ' · queued' : ''}
          </span>
        )}
        {box.width > 75 && box.height > 76 && <span className="map-size">{formatBytes(item.size)}</span>}
      </>
    )
    return (
      <div
        key={row?.nodeId ?? 'group'}
        className={`map-tile map-color-${color % 5}${row?.kind === 'rest' ? ' map-small-files' : ''}${isStaged ? ' map-staged' : ''}`}
        style={position(box)}
      >
        {interactive ? (
          <button
            className={`map-hit${inset ? ' map-folder-heading' : ''}`}
            aria-label={`${item.name}, ${formatBytes(item.size)}${row?.kind === 'dir' || item.grouped ? ', open folder' : ''}${isStaged ? ', queued for deletion' : ''}`}
            title={`${fullPath}\n${formatBytes(item.size)}${row?.kind === 'dir' || item.grouped ? '\nClick to zoom in' : ''}`}
            onClick={() => {
              setDetail({ entry: item, path: fullPath })
              void open(item, parent)
            }}
            onMouseEnter={() => setDetail({ entry: item, path: fullPath })}
            onFocus={() => setDetail({ entry: item, path: fullPath })}
            onKeyDown={openRowContext}
            onContextMenu={(event) => {
              if (row && row.kind !== 'rest')
                onContext(
                  { nodeId: row.nodeId, kind: row.kind, size: row.size, files: row.files, canDelete: depth >= 1 },
                  event,
                )
            }}
          >
            {content}
          </button>
        ) : (
          <div
            className="map-hit"
            title={`${item.name}: ${formatBytes(item.size)}`}
            onMouseEnter={() => setDetail({ entry: item, path: fullPath })}
          >
            {content}
          </div>
        )}
        {inset && (
          <div className="map-children">
            {treemap(mapEntries(nestedRows, 40), Math.max(0, box.width - 12), Math.max(0, box.height - 40)).map(
              (child) => tile(child, color, depth + 1, fullPath, item),
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="view treemap-view">
      <div className="view-bar">
        <ScanPicker label="Scan" scans={scans} value={scanId} onChange={onPick} />
        <span className="strong">{formatBytes(total.visible.size)} visible</span>
        <span className="muted small">
          {formatBytes(total.raw.size)} captured · {formatBytes(total.hidden.size)} hidden
          {scans.find((scan) => scan.id === scanId)!.errors > 0 ? ' · Some items could not be read' : ''}
        </span>
      </div>
      <ScanDiagnostics key={scan.id} scan={scan} unix={!isWindows(disk)} onChooseDrive={onChooseDrive} />
      <div className="map-navigation">
        <nav className="map-breadcrumbs" aria-label="Treemap location">
          {trail.map((part, index) => (
            <button
              key={index}
              aria-current={index === trail.length - 1 ? 'location' : undefined}
              onClick={() => {
                ++request.current
                setLoading(false)
                setError(null)
                setDetail(null)
                setTrail(trail.slice(0, index + 1))
              }}
            >
              {part.name}
            </button>
          ))}
        </nav>
        <span className="num strong">{formatBytes(size)}</span>
      </div>
      <p className="muted small map-help">Area shows size. Click a folder to zoom in. Right-click for file actions.</p>
      {error && (
        <div className="notice" role="alert">
          <span>Could not open folder: {error.message}</span>
          <button onClick={() => void open(error.entry, error.parent)}>Retry</button>
        </div>
      )}
      <div className="map-canvas" ref={canvas} aria-label="Disk usage treemap" aria-busy={loading}>
        {size > 0 ? (
          boxes.map((box, i) => tile(box, i, location.depth, path))
        ) : (
          <p className="map-empty">
            {scan.coverage === 'partial'
              ? 'No visible data was captured here. This scan has partial coverage.'
              : scan.files === 0 && (scan.skipped?.mounts ?? 0) > 0
                ? 'No files were captured within this mount scope.'
                : 'No visible disk usage in this folder.'}
          </p>
        )}
        {loading && (
          <div className="map-loading" role="status">
            Loading folder…
          </div>
        )}
      </div>
      <div className="map-detail" aria-live="polite">
        <span className="path">{detail?.path ?? path}</span>
        <span className="num">
          {formatBytes(detail?.entry.size ?? size)}
          {detail && size > 0 ? ` · ${((detail.entry.size / size) * 100).toFixed(1)}%` : ''}
        </span>
        {detail?.entry.row && <span className="muted small">{formatCount(detail.entry.row.files)} files</span>}
      </div>
    </div>
  )
}
