import { useState } from 'react'
import { api } from './api'

export function MacDiskAccess() {
  const [message, setMessage] = useState('')
  const openSettings = async () => {
    try {
      await api.openFullDiskAccessSettings()
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <section>
      <h2>Full Disk Access</h2>
      <p>
        To reduce permission prompts and include protected folders, add Disk Watch in System Settings → Privacy &amp;
        Security → Full Disk Access. This grants broad access to your files.
      </p>
      <div className="disk-access-actions">
        <button onClick={openSettings}>Open Full Disk Access settings</button>
      </div>
      <p className="muted small">
        Click +, choose Applications, select Disk Watch, then click Open and enable its switch. Quit and reopen Disk
        Watch after changing access, then start a new scan.
      </p>
      {message && <p role="status">{message}</p>}
    </section>
  )
}
