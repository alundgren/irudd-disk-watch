import { useEffect, useRef, useState } from 'react'
import type { DeleteFailure, DeleteResult, LockProcess } from '../../shared/types'
import { api } from './api'

const unavailable = 'Unavailable'
const isUnixFailure = (failure: DeleteFailure) =>
  !!failure.errorDomain && failure.errorDomain !== 'windows' && failure.errorDomain !== 'win32'
const errorLabel = (failure: DeleteFailure) =>
  isUnixFailure(failure) ? `${failure.errorDomain} error code` : 'Windows error code'

function processValues(process: LockProcess): [string, string | null][] {
  return [
    ['Program name', process.programName],
    ['Process name', process.processName],
    ['Process ID', String(process.pid)],
    ['Executable path', process.executablePath],
    ...(process.serviceName ? [['Service name', process.serviceName] as [string, string]] : []),
  ]
}

function lookupMessage(failure: DeleteFailure): string {
  if (isUnixFailure(failure))
    return 'Process lookup is unavailable for this native worker. Check the reported filesystem error.'
  switch (failure.lockInfo?.status) {
    case 'found':
      return 'Processes using this path'
    case 'none':
      return 'Windows did not identify a process using this path. The lock may have been released, or its owner may not be visible.'
    case 'unavailable':
      return 'Windows could not identify the processes using this path.'
    case 'not_checked':
      return 'Process lookup was not needed for this failure.'
    default:
      return 'Process details are unavailable for this deletion result.'
  }
}

export function deletionReport(result: DeleteResult): string {
  const lines = [
    'Disk Watch deletion report',
    ...(result.machineName ? [`Machine: ${result.machineName}`] : []),
    ...(result.operationId ? [`Operation: ${result.operationId} · ${result.state ?? 'unknown'}`] : []),
    `Removed ${result.deleted.length} of ${result.deleted.length + result.failed.length} queued paths.`,
    'Deletion can remove some contents of a failed folder. Saved scans remain unchanged.',
  ]
  for (const [index, failure] of result.failed.entries()) {
    lines.push('', `Failure ${index + 1}`, `Failed operation path: ${failure.failedPath ?? failure.path}`)
    lines.push(lookupMessage(failure))
    for (const [index, process] of (failure.lockInfo?.processes ?? []).entries()) {
      lines.push(`Process ${index + 1}`)
      for (const [label, value] of processValues(process)) lines.push(`${label}: ${value ?? unavailable}`)
      lines.push(
        `Reported by: ${process.source === 'restart_manager' ? 'Windows Restart Manager' : 'Windows open-handle query'}`,
      )
      if (process.note) lines.push(process.note)
    }
    lines.push(`Error: ${failure.message}`)
    if (failure.errorCode != null) lines.push(`${errorLabel(failure)}: ${failure.errorCode}`)
    lines.push(`Queued path: ${failure.path}`)
    if (failure.lockInfo?.note) lines.push(failure.lockInfo.note)
  }
  return lines.join('\n')
}

export function DeleteFailureDialog({ result, onClose }: { result: DeleteResult; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [copyError, setCopyError] = useState(false)
  useEffect(() => {
    const element = dialog.current!
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    return () => element.close()
  }, [])
  const close = () => {
    dialog.current?.close()
    onClose()
    if (origin.current?.isConnected) origin.current.focus()
  }
  const copy = async (value: string, label: string) => {
    try {
      await api.copyText(value)
      setCopyError(false)
      setFeedback(`${label} copied.`)
    } catch {
      setCopyError(true)
      setFeedback(
        `Could not copy. Select the value and press ${navigator.platform.startsWith('Mac') ? 'Cmd+C' : 'Ctrl+C'}.`,
      )
    }
  }
  const field = (label: string, value: string | null, mono = true) => (
    <div className="failure-field" key={label}>
      <dt>{label}</dt>
      <dd className={mono ? 'path' : undefined}>{value ?? unavailable}</dd>
      {value !== null && (
        <button type="button" onClick={() => void copy(value, label)} aria-label={`Copy ${label.toLowerCase()}`}>
          Copy
        </button>
      )}
    </div>
  )
  return (
    <dialog
      ref={dialog}
      className="delete-failure-dialog"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      aria-labelledby="failure-title"
      aria-describedby="failure-description"
    >
      <header>
        <h2 id="failure-title">Some paths could not be deleted</h2>
        {result.machineName && <p className="muted">{result.machineName}</p>}
        <p id="failure-description">
          Removed {result.deleted.length} of {result.deleted.length + result.failed.length} queued paths. Failed paths
          stay queued. A failed folder may have had some contents removed.
        </p>
      </header>
      <div className="failure-details">
        {result.failed.map((failure, index) => (
          <section className="deletion-failure" key={failure.path} aria-label={`Failed path ${index + 1}`}>
            {result.failed.length > 1 && (
              <h3>
                Failed path {index + 1} of {result.failed.length}
              </h3>
            )}
            <dl>{field('Failed operation path', failure.failedPath ?? failure.path)}</dl>
            <h3>{failure.lockInfo?.status === 'found' ? lookupMessage(failure) : 'Process lookup'}</h3>
            {failure.lockInfo?.status !== 'found' && <p>{lookupMessage(failure)}</p>}
            {failure.lockInfo?.processes.map((process) => (
              <div className="lock-process" key={process.pid} aria-label={`Process ${process.pid}`}>
                <dl>{processValues(process).map(([label, value]) => field(label, value))}</dl>
                <p className="muted small">
                  {process.source === 'restart_manager'
                    ? 'Reported by Windows Restart Manager.'
                    : 'Windows reports an open handle to this path.'}
                  {process.note && ` ${process.note}`}
                </p>
              </div>
            ))}
            <dl className="failure-context">
              {field('Error', failure.message, false)}
              {failure.errorCode != null && field(errorLabel(failure), String(failure.errorCode))}
              {field('Queued path', failure.path)}
            </dl>
            {failure.lockInfo?.note && <p className="muted small">{failure.lockInfo.note}</p>}
          </section>
        ))}
      </div>
      <footer>
        <p className="muted small">
          {result.failed.some((failure) => failure.lockInfo?.status === 'found')
            ? 'Close the program or use its PID in Task Manager, then retry the queued paths.'
            : 'Resolve the reported error before retrying the queued paths.'}{' '}
          Saved scans remain unchanged.
        </p>
        <div className="failure-dialog-actions">
          <span role="status" className={copyError ? 'grew' : 'muted'}>
            {feedback}
          </span>
          <button type="button" onClick={() => void copy(deletionReport(result), 'Report')}>
            Copy report
          </button>
          <button type="button" className="primary" onClick={close} autoFocus>
            Close
          </button>
        </div>
      </footer>
    </dialog>
  )
}
