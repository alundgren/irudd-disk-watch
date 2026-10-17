import { useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../../shared/updates'
import { api } from './api'
import { errorText } from './bulkQueue'
import { UpdateSettings } from './UpdateSettings'
import { GitHubAccessSettings } from './GitHubAccessSettings'

export function AppUpdatesDialog({ filesystemBusy, onClose }: { filesystemBusy: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let observedState = false
    const element = dialog.current!
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    const unsubscribe = api.updates.onState((next) => {
      observedState = true
      if (active) setState(next)
    })
    void api.updates.getState().then(
      (next) => {
        if (active && !observedState) setState(next)
      },
      (error) => {
        if (active) setError(errorText(error))
      },
    )
    return () => {
      active = false
      unsubscribe()
      element.close()
      if (origin?.isConnected) origin.focus()
    }
  }, [])
  const act = async (action: 'check' | 'download' | 'installAndRestart') => {
    setError('')
    try {
      setState(await api.updates[action]())
    } catch (error) {
      setError(errorText(error))
    }
  }
  const installing = state?.phase === 'installing'
  return (
    <dialog
      ref={dialog}
      className="hide-dialog"
      aria-label="Disk Watch updates"
      onCancel={(event) => {
        event.preventDefault()
        if (!installing) onClose()
      }}
    >
      {state ? (
        <UpdateSettings
          state={state}
          filesystemBusy={filesystemBusy}
          onCheck={() => void act('check')}
          onDownload={() => void act('download')}
          onInstall={() => void act('installAndRestart')}
        />
      ) : (
        <p role="status">Reading the installed app version…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {!installing && <GitHubAccessSettings onChanged={() => void act('check')} />}
      <footer className="dialog-actions">
        <button type="button" disabled={installing} onClick={onClose}>
          Close
        </button>
      </footer>
    </dialog>
  )
}
