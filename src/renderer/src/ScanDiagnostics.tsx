import { useEffect, useRef, useState } from 'react'
import type { ScanIssues, ScanSummary } from '../../shared/types'
import { api, formatCount } from './api'

export function ScanDiagnostics({
  scan,
  unix,
  onChooseDrive,
}: {
  scan: ScanSummary
  unix: boolean
  onChooseDrive(): void
}) {
  const [open, setOpen] = useState(false)
  const [issues, setIssues] = useState<ScanIssues | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const request = useRef(0)
  const partial = scan.coverage === 'partial'
  const skippedMounts = scan.files === 0 && (scan.skipped?.mounts ?? 0) > 0
  const total = Math.max(scan.errors, issues?.total ?? 0)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      ++request.current
    }
  }, [])
  const load = async () => {
    const identity = ++request.current
    setLoading(true)
    setError(null)
    try {
      const result = await api.scanIssues(scan.id)
      if (active.current && identity === request.current) setIssues(result)
    } catch (error) {
      if (active.current && identity === request.current)
        setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (active.current && identity === request.current) setLoading(false)
    }
  }
  return (
    <section className={`scan-diagnostics${partial ? ' scan-partial' : ''}`} aria-label="Saved scan diagnostics">
      {(partial || skippedMounts) && (
        <div className="scan-warning" role="status">
          <p>
            {partial ? (
              <>
                {scan.size === 0
                  ? 'No accessible file data was captured. This partial scan does not show that the drive is empty.'
                  : 'This scan has partial coverage. Captured sizes may be incomplete.'}{' '}
                {unix
                  ? 'Changes requires a scan with complete coverage. Cleanup is limited to items with nothing unreadable inside them.'
                  : 'Changes requires a scan with complete coverage.'}
              </>
            ) : (
              'No files were captured within this mount scope. Nested mounts were intentionally skipped. Choose the drive that holds your files.'
            )}
          </p>
          <button type="button" onClick={onChooseDrive}>
            Choose a drive
          </button>
        </div>
      )}
      <button
        type="button"
        className="link"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (!open && !issues && !loading) void load()
        }}
      >
        {open ? 'Hide scan details' : 'Scan details'}
        {total > 0 ? ` · ${formatCount(total)} ${total === 1 ? 'item could' : 'items could'} not be read` : ''}
      </button>
      {open && (
        <div className="scan-details">
          <p>
            {partial ? 'Partial coverage' : 'Complete coverage'} · {formatCount(total)}{' '}
            {total === 1 ? 'read error' : 'read errors'}
          </p>
          {scan.message && <p className="scan-message">{scan.message}</p>}
          {scan.policy && (
            <p className="muted small">
              {scan.policy === 'regular-files-single-mount-no-symlink-traversal'
                ? 'Scan scope includes regular files on one mount without following symbolic links.'
                : `Recorded scan scope: ${scan.policy}`}
            </p>
          )}
          {scan.skipped && (
            <p className="muted small">
              Skipped by scan scope: {formatCount(scan.skipped.symlinks)} symbolic links ·{' '}
              {formatCount(scan.skipped.special)} special items · {formatCount(scan.skipped.mounts)} mount points. These
              counts are separate from read errors.
            </p>
          )}
          {loading && <p role="status">Loading saved issues…</p>}
          {error && (
            <div className="notice" role="alert">
              <span>Could not load saved issues: {error}</span>
              <button type="button" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          {issues && (
            <>
              {issues.issues.length > 0 ? (
                <>
                  <p className="muted small">
                    Showing {formatCount(issues.issues.length)} saved {issues.issues.length === 1 ? 'issue' : 'issues'}{' '}
                    of {formatCount(total)} read errors.
                    {issues.issues.length < total ? ' Only a bounded sample was saved.' : ''}
                  </p>
                  <ul className="scan-issue-list" aria-label="Saved scan issues">
                    {issues.issues.map((issue, index) => (
                      <li key={index}>
                        <span className="path">{issue.path}</span>
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted small">
                  {total > 0
                    ? 'No issue samples were saved with this scan. The total error count is retained.'
                    : 'No read errors were saved with this scan.'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
