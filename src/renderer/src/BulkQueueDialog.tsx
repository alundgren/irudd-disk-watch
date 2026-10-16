import { useEffect, useRef, useState } from 'react'
import type { SearchRow } from '../../shared/types'
import { formatBytes, formatCount } from './api'
import type { BulkOutcome, BulkPlan, SkippedItem } from './bulkQueue'

const PREVIEW = 10

interface BulkQueueDialogProps {
  plan: BulkPlan
  onQueue(rows: SearchRow[], signal: AbortSignal, onProgress: (done: number) => void): Promise<BulkOutcome>
  onClose(): void
}

const items = (count: number) => `${formatCount(count)} ${count === 1 ? 'item' : 'items'}`

export function BulkQueueDialog({ plan, onQueue, onClose }: BulkQueueDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const stop = useRef<AbortController | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null)
  const unmounted = useRef(false)
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    unmounted.current = false
    dialog.current?.showModal()
    return () => {
      unmounted.current = true
      stop.current?.abort()
      dialog.current?.close()
      if (origin?.isConnected) origin.focus()
    }
  }, [])
  const running = done !== null && !outcome
  const queue = async () => {
    stop.current = new AbortController()
    setDone(0)
    setOutcome(await onQueue(plan.queue, stop.current.signal, setDone))
  }
  const skipped = outcome ? [...plan.skipped, ...outcome.skipped] : plan.skipped
  return (
    <dialog
      ref={dialog}
      className="hide-dialog bulk-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (running) stop.current?.abort()
        else onClose()
      }}
      onClose={() => {
        // The browser can close a modal on its own; keep the parent's state in step.
        if (!unmounted.current) {
          stop.current?.abort()
          onClose()
        }
      }}
      aria-labelledby="bulk-title"
    >
      {outcome ? (
        <>
          <h2 id="bulk-title">
            {outcome.queued ? `Queued ${items(outcome.queued)} for deletion` : 'Nothing was queued'}
          </h2>
          {outcome.stopped && <p role="alert">{outcome.stopped}</p>}
          <p className="muted">Review the queue above the tabs, then use Execute delete when you are ready.</p>
        </>
      ) : (
        <>
          <h2 id="bulk-title">
            {plan.queue.length ? `Queue ${items(plan.queue.length)} for deletion` : 'Nothing to queue'}
          </h2>
          {plan.queue.length > 0 && (
            <>
              <p>
                <span className="strong danger-text">{formatBytes(plan.size)}</span>{' '}
                <span className="muted">
                  estimated from the selected scan. This adds items to the deletion queue; nothing is deleted until you
                  choose Execute delete.
                </span>
              </p>
              <PathList
                rows={plan.queue.map((row) => ({ key: row.nodeId, path: row.path, detail: formatBytes(row.size) }))}
              />
            </>
          )}
          {plan.absorbed > 0 && (
            <p className="muted small">
              {items(plan.absorbed)} already in the queue {plan.absorbed === 1 ? 'is' : 'are'} inside selected folders
              and will be merged into them.
            </p>
          )}
        </>
      )}
      {skipped.length > 0 && (
        <section aria-label="Skipped items">
          <h3 className="bulk-subtitle">Skipped {items(skipped.length)}</h3>
          <SkippedList items={skipped} />
        </section>
      )}
      {!outcome && plan.queue.some((row) => row.kind === 'dir') && (
        <p className="muted small">
          Deleting a folder also deletes items inside it that are hidden from views. The size above does not count them.
        </p>
      )}
      {!outcome && plan.queue.length > 0 && (
        <p className="muted small">
          Saved scans do not change when files are removed. After the delete runs, scan again to see current contents
          before queueing more.
        </p>
      )}
      <div className="dialog-actions">
        {outcome || !plan.queue.length ? (
          <button className="primary" autoFocus onClick={onClose}>
            Close
          </button>
        ) : running ? (
          <>
            <span className="muted small" role="status">
              Queueing {formatCount(done)} of {formatCount(plan.queue.length)}…
            </span>
            <button onClick={() => stop.current?.abort()}>Stop</button>
          </>
        ) : (
          <>
            <button autoFocus onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={() => void queue()}>
              Queue {items(plan.queue.length)}
            </button>
          </>
        )}
      </div>
    </dialog>
  )
}

function PathList({ rows }: { rows: { key: number; path: string; detail: string }[] }) {
  return (
    <ul className="plain-list bulk-list">
      {rows.slice(0, PREVIEW).map((row) => (
        <li key={row.key}>
          <span className="path">{row.path}</span>
          <span className="num muted">{row.detail}</span>
        </li>
      ))}
      {rows.length > PREVIEW && <li className="muted">and {items(rows.length - PREVIEW)} more</li>}
    </ul>
  )
}

/** Every skip stays listed: the reason may differ per item. */
function SkippedList({ items }: { items: SkippedItem[] }) {
  return (
    <ul className="plain-list bulk-list bulk-skipped">
      {items.map((item) => (
        <li key={item.nodeId}>
          <span className="path">{item.path}</span>
          <span className="muted small">{item.reason}</span>
        </li>
      ))}
    </ul>
  )
}
