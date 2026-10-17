import { useEffect, useState } from 'react'
import type { GitHubAccessState } from '../../shared/githubAccess'
import { api } from './api'
import { errorText } from './bulkQueue'

export function GitHubAccessSettings({ onChanged }: { onChanged(): void }) {
  const [state, setState] = useState<GitHubAccessState | null>(null)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void api.githubAccess.getState().then(
      (next) => {
        if (active) setState(next)
      },
      (error) => {
        if (active) setError(errorText(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <section aria-labelledby="github-access-heading" aria-busy={busy}>
      <h2 id="github-access-heading">GitHub access</h2>
      <p>
        Downloads from this private repository need a GitHub token with Contents read access to
        alundgren/irudd-disk-watch. Save it once on this computer. The OS encrypts it for later app and SSH scanner
        updates.
      </p>
      {state?.source === 'saved' && <p role="status">GitHub access is saved on this computer.</p>}
      {state?.source === 'environment' && <p role="status">Using GitHub access from the launch environment.</p>}
      {state?.message && <p role="alert">{state.message}</p>}
      {state && !state.canSave && <p>OS credential encryption is unavailable, so this app cannot save a token.</p>}
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (!state?.canSave || busy) return
          setBusy(true)
          setError('')
          try {
            setState(await api.githubAccess.save(token))
            setToken('')
            onChanged()
          } catch (error) {
            setError(errorText(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label htmlFor="github-access-token">GitHub token</label>
        <input
          id="github-access-token"
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          disabled={!state?.canSave || busy}
          onChange={(event) => setToken(event.target.value)}
        />
        <div className="disk-access-actions">
          <button type="submit" disabled={!state?.canSave || !token || busy}>
            {busy ? 'Saving…' : state?.source === 'saved' ? 'Replace saved access' : 'Save access'}
          </button>
          {state?.hasSavedRecord && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  setState(await api.githubAccess.clear())
                  onChanged()
                } catch (error) {
                  setError(errorText(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Remove saved access
            </button>
          )}
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
