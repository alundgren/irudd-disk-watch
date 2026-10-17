import { useState } from 'react'
import { api } from './api'
import { errorText } from './bulkQueue'

export function RemoteScannerSettings({
  destination,
  disabled = false,
  onInstalled,
  onBusyChange,
}: {
  destination: string
  disabled?: boolean
  onInstalled?(): void
  onBusyChange?(busy: boolean): void
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  return (
    <div className="remote-scanner-settings">
      <p className="muted small">
        Install the matching scanner over SSH. This uses your existing SSH key and verified host key, keeps scanner
        state, and needs no daemon or build tools on the remote.
      </p>
      <button
        type="button"
        disabled={disabled || busy || !destination.trim()}
        onClick={async () => {
          setBusy(true)
          onBusyChange?.(true)
          setFailed(false)
          setMessage('Checking the remote and downloading the matching scanner…')
          try {
            const result = await api.installSshScanner(destination.trim())
            setMessage(result.message)
            onInstalled?.()
          } catch (error) {
            setFailed(true)
            setMessage(errorText(error))
          } finally {
            setBusy(false)
            onBusyChange?.(false)
          }
        }}
      >
        {busy ? 'Installing scanner…' : failed ? 'Retry scanner installation' : 'Install or update scanner'}
      </button>
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    </div>
  )
}
