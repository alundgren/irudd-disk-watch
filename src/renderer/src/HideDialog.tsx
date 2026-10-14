import { useEffect, useRef, useState } from 'react'
import { pathAncestors } from '../../shared/paths'

interface HideDialogProps {
  root: string
  path: string
  editing: boolean
  onSave(path: string): Promise<void>
  onClose(): void
}

export function HideDialog({ root, path, editing, onSave, onClose }: HideDialogProps) {
  const [value, setValue] = useState(path)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  let ancestors: string[] = []
  try {
    ancestors = pathAncestors(root, value)
  } catch {
    /* Editing may temporarily be incomplete. */
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(value)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <dialog ref={dialog} className="hide-dialog" onCancel={onClose} aria-labelledby="hide-title">
      <form onSubmit={save}>
        <h2 id="hide-title">{editing ? 'Edit hidden path' : 'Hide from views'}</h2>
        <p className="muted">Applies to every scan of this drive. Captured scans and files stay intact.</p>
        <label htmlFor="hide-path">Full path</label>
        <input
          id="hide-path"
          className="path"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
          disabled={saving}
        />
        {ancestors.length > 1 && (
          <div className="ancestors" aria-label="Choose an ancestor">
            <span className="muted small">Or hide a containing folder</span>
            {ancestors.slice(1).map((ancestor) => (
              <button
                type="button"
                className="path"
                key={ancestor}
                onClick={() => setValue(ancestor)}
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
