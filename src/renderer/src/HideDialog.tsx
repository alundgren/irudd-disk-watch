import { useEffect, useRef, useState } from 'react'
import { pathAncestors } from '../../shared/paths'
import { errorText } from './bulkQueue'

interface HideDialogProps {
  root: string
  path: string
  components?: string[]
  unix?: boolean
  editing: boolean
  onSave(path: string, components?: string[]): Promise<void>
  onClose(): void
}

export function HideDialog({ root, path, components, unix, editing, onSave, onClose }: HideDialogProps) {
  const [value, setValue] = useState(path)
  const [selected, setSelected] = useState(components)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    return () => {
      dialog.current?.close()
      if (origin?.isConnected) origin.focus()
    }
  }, [])
  let ancestors: string[] = []
  try {
    ancestors = unix
      ? (components?.map((_, index) =>
          path
            .split('/')
            .slice(0, path.split('/').length - index)
            .join('/'),
        ) ?? [])
      : pathAncestors(root, value)
  } catch {
    /* Editing may temporarily be incomplete. */
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(value, selected)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="hide-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
      aria-labelledby="hide-title"
    >
      <form onSubmit={save}>
        <h2 id="hide-title">{editing ? 'Edit hidden path' : 'Hide from views'}</h2>
        <p className="muted">Applies to every scan of this tracked root. Captured scans and files stay intact.</p>
        <label htmlFor="hide-path">Full path</label>
        <input
          id="hide-path"
          className="path"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setSelected(undefined)
          }}
          autoFocus
          disabled={saving}
        />
        {ancestors.length > 1 && (
          <div className="ancestors" aria-label="Choose an ancestor">
            <span className="muted small">Or hide a containing folder</span>
            {ancestors.slice(1).map((ancestor, index) => (
              <button
                type="button"
                className="path"
                key={ancestor}
                onClick={() => {
                  setValue(ancestor)
                  if (unix) setSelected(components?.slice(0, components.length - index - 1))
                }}
                disabled={saving}
              >
                {ancestor}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="grew">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Hide path'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
