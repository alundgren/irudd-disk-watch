import { useEffect, useRef, useState, type FormEvent } from 'react'

interface Props {
  onSave(destination: string, path: string): Promise<void>
  onClose(): void
}

export function SshDialog({ onSave, onClose }: Props) {
  const [destination, setDestination] = useState('')
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    return () => {
      dialog.current?.close()
      if (origin?.isConnected) origin.focus()
    }
  }, [])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(destination.trim(), path)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="hide-dialog"
      aria-labelledby="ssh-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
    >
      <form onSubmit={save}>
        <h2 id="ssh-title">Track over SSH</h2>
        <p className="muted">
          Use an SSH alias or user@host with existing key authentication. The native worker must be installed on that
          machine.
        </p>
        <label htmlFor="ssh-destination">SSH destination</label>
        <input
          id="ssh-destination"
          className="path"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          autoFocus
          required
          disabled={saving}
          autoComplete="off"
        />
        <label htmlFor="ssh-root">Remote root</label>
        <input
          id="ssh-root"
          className="path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="Absolute folder path"
          required
          disabled={saving}
          autoComplete="off"
        />
        {error && (
          <p className="grew" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" disabled={saving || !destination.trim() || !path}>
            {saving ? 'Connecting…' : 'Track over SSH'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
