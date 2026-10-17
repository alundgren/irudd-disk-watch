import { useCallback, useEffect, useRef, useState, useReducer, type FormEvent } from 'react'
import type { Disk, NativeVolume } from '../../shared/types'
import { api, formatBytes, formatCount, formatWhen } from './api'
import { canTrackVolume, volumeChoices, volumeExplanation } from './volumeChoice'
import { initialDiscovery, volumeDiscovery } from './volumeDiscovery'
import { errorText } from './bulkQueue'
import { RemoteScannerSettings } from './RemoteScannerSettings'

type Source = 'local' | 'ssh'
interface Props {
  initialSource: Source
  initialDestination?: string
  onTracked(disk: Disk): Promise<void>
  onClose(): void
}

export function VolumeChooser({ initialSource, initialDestination, onTracked, onClose }: Props) {
  const [source, setSource] = useState(initialSource)
  const [destination, setDestination] = useState(initialDestination ?? '')
  const [{ discovery, selected, loading, error }, dispatch] = useReducer(volumeDiscovery, initialDiscovery)
  const [showSystem, setShowSystem] = useState(false)
  const [folder, setFolder] = useState(false)
  const [path, setPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [installing, setInstalling] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef(0)
  const active = useRef(true)
  const busy = loading || adding || installing

  const discover = useCallback(async (remote?: string) => {
    const identity = ++request.current
    dispatch({ type: 'start', request: identity })
    try {
      const result = await api.discoverVolumes(remote)
      if (!active.current || identity !== request.current) return
      dispatch({ type: 'received', request: identity, discovery: result })
    } catch (error) {
      if (active.current) dispatch({ type: 'failed', request: identity, message: errorText(error) })
    }
  }, [])

  useEffect(() => {
    const element = dialog.current!
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    active.current = true
    element.showModal()
    return () => {
      active.current = false
      ++request.current
      element.close()
      if (origin?.isConnected) origin.focus()
    }
  }, [])

  useEffect(() => {
    dispatch({ type: 'invalidate', request: ++request.current })
    setFolder(false)
    setPath('')
    setShowSystem(false)
    if (source === 'local') void discover()
  }, [source, discover])

  const track = async (event: FormEvent) => {
    event.preventDefault()
    if (!discovery || busy) return
    const volume = discovery.volumes.find((item) => item.id === selected)
    if (!folder && (!volume || !canTrackVolume(volume))) return
    setAdding(true)
    dispatch({ type: 'inspection-error', request: request.current, message: '' })
    try {
      const disk = folder
        ? await api.addFolder(discovery.machine.id, path)
        : await api.addVolume(discovery.machine.id, volume!)
      if (!active.current) return
      await onTracked(disk)
      if (active.current) onClose()
    } catch (error) {
      if (active.current)
        dispatch({
          type: 'inspection-error',
          request: request.current,
          message: errorText(error),
        })
    } finally {
      if (active.current) setAdding(false)
    }
  }
  const close = () => {
    if (adding || installing) return
    dispatch({ type: 'invalidate', request: ++request.current })
    onClose()
  }
  const switchSource = (next: Source) => {
    if (next === source) return
    dispatch({ type: 'invalidate', request: ++request.current })
    setSource(next)
  }
  const volumes = discovery ? volumeChoices(discovery.volumes, showSystem) : []
  const systems = discovery?.volumes.filter((volume) => volume.kind === 'system').length ?? 0
  const selectedVolume = discovery?.volumes.find((volume) => volume.id === selected)

  return (
    <dialog
      ref={dialog}
      className="hide-dialog volume-dialog"
      aria-labelledby="volume-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!adding && !installing) close()
      }}
    >
      <header>
        <h2 id="volume-title">Track a drive or folder</h2>
        <p className="muted">Choose what to track. You can scan it when you are ready.</p>
        <div className="volume-source" aria-label="Execution machine">
          <button
            type="button"
            aria-pressed={source === 'local'}
            disabled={adding || installing}
            onClick={() => switchSource('local')}
          >
            This computer
          </button>
          <button
            type="button"
            aria-pressed={source === 'ssh'}
            disabled={adding || installing}
            onClick={() => switchSource('ssh')}
          >
            Over SSH
          </button>
        </div>
      </header>
      {source === 'ssh' && (
        <form
          className="volume-connection"
          onSubmit={(event) => {
            event.preventDefault()
            void discover(destination.trim())
          }}
        >
          <label htmlFor="volume-destination">SSH destination</label>
          <p className="muted small">
            Use your existing SSH alias or user@host. Connect if the scanner is installed, or install it below.
          </p>
          <div className="volume-connect-row">
            <input
              id="volume-destination"
              className="path"
              value={destination}
              autoFocus={initialSource === 'ssh'}
              autoComplete="off"
              required
              disabled={busy}
              onChange={(event) => {
                dispatch({ type: 'invalidate', request: ++request.current })
                setDestination(event.target.value)
                setFolder(false)
                setPath('')
                setShowSystem(false)
              }}
            />
            <button disabled={busy || !destination.trim()}>
              {loading ? 'Connecting…' : discovery ? 'Refresh' : 'Connect'}
            </button>
          </div>
          <RemoteScannerSettings
            key={destination.trim()}
            destination={destination}
            disabled={busy}
            onInstalled={() => void discover(destination.trim())}
            onBusyChange={setInstalling}
          />
        </form>
      )}
      {source === 'local' && (
        <button type="button" className="volume-refresh" disabled={busy} onClick={() => void discover()}>
          Refresh drives
        </button>
      )}
      {loading && (
        <p role="status" className="volume-loading">
          <span className="spinner" aria-hidden />{' '}
          {source === 'ssh' ? 'Connecting and finding drives…' : 'Finding drives…'}
        </p>
      )}
      {error && (
        <div role="alert" className="volume-error">
          <p>{error}</p>
          {!discovery && (
            <button
              type="button"
              disabled={busy || (source === 'ssh' && !destination.trim())}
              onClick={() => void discover(source === 'ssh' ? destination.trim() : undefined)}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <form onSubmit={track}>
        {discovery && (
          <>
            <p className="muted small volume-observation">
              {discovery.machine.name} · Observed {formatWhen(discovery.observedAt)}
            </p>
            {discovery.errors > 0 && (
              <p role="status" className="scan-warning">
                Some drive details are unavailable. Refresh to retry, or enter a folder path.
              </p>
            )}
            {discovery.truncated && (
              <p role="status" className="scan-warning">
                This drive list is incomplete. Enter a folder path if your drive is missing.
              </p>
            )}
            {!folder && (
              <>
                {volumes.length > 0 ? (
                  <fieldset className="volume-list" disabled={adding}>
                    <legend className="visually-hidden">Choose a drive</legend>
                    {volumes.map((volume) => (
                      <VolumeOption
                        key={volume.id}
                        volume={volume}
                        selected={selected === volume.id}
                        onSelect={() => dispatch({ type: 'select', request: request.current, id: volume.id })}
                        onFolder={() => {
                          setFolder(true)
                          setPath('')
                        }}
                      />
                    ))}
                  </fieldset>
                ) : (
                  <p className="volume-empty">
                    {systems > 0 && !showSystem
                      ? 'Only system volumes were found. Show them below or enter a folder path.'
                      : 'No drives were found. Refresh the list or enter a folder path.'}
                  </p>
                )}
                {systems > 0 && (
                  <label className="volume-system-toggle">
                    <input
                      type="checkbox"
                      checked={showSystem}
                      disabled={adding}
                      onChange={(event) => {
                        setShowSystem(event.target.checked)
                        if (!event.target.checked && selectedVolume?.kind === 'system')
                          dispatch({ type: 'select', request: request.current, id: null })
                      }}
                    />{' '}
                    Show system volumes ({formatCount(systems)})
                  </label>
                )}
              </>
            )}
            <button
              type="button"
              className="link volume-folder-toggle"
              disabled={adding}
              onClick={() => setFolder((value) => !value)}
            >
              {folder ? 'Choose a drive instead' : 'Track a folder instead'}
            </button>
            {folder && (
              <div className="volume-folder">
                <label htmlFor="volume-folder-path">Folder path on {discovery.machine.name}</label>
                <input
                  id="volume-folder-path"
                  className="path"
                  value={path}
                  autoComplete="off"
                  autoFocus
                  required
                  disabled={adding}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="Absolute folder path"
                />
                <p className="muted small">The folder is inspected on this machine before it is added.</p>
              </div>
            )}
          </>
        )}
        <footer className="dialog-actions">
          <button type="button" disabled={adding || installing} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!discovery || busy || (folder ? !path : !selectedVolume || !canTrackVolume(selectedVolume))}
          >
            {adding ? 'Inspecting…' : folder ? 'Track folder' : 'Track drive'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}

export function VolumeOption({
  volume,
  selected,
  onSelect,
  onFolder,
}: {
  volume: NativeVolume
  selected: boolean
  onSelect(): void
  onFolder(): void
}) {
  const trackable = canTrackVolume(volume)
  const explanation = volumeExplanation(volume)
  return (
    <div className={`volume-option${volume.recommended ? ' volume-recommended' : ''}`}>
      <label className="volume-choice">
        <input
          type="radio"
          name="tracked-volume"
          value={volume.id}
          checked={selected}
          onChange={onSelect}
          disabled={!trackable}
        />
        <span className="volume-description">
          <span className="volume-name">
            {volume.name}
            {volume.recommended && <span className="tag">Recommended</span>}
          </span>
          <span className="path">{volume.path}</span>
          {explanation && <span>{explanation}</span>}
          <span className="muted small">
            {volume.filesystem ?? 'Filesystem unavailable'} ·{' '}
            {volume.kind === 'system'
              ? 'System'
              : volume.kind === 'network'
                ? 'Network'
                : volume.kind === 'removable'
                  ? 'Removable'
                  : 'Local'}
            {volume.readOnly === true
              ? ' · Read-only, scanning available'
              : volume.readOnly === null
                ? ' · Write access unknown'
                : ''}
          </span>
          <span className="muted small">
            {volume.capacity
              ? `${formatBytes(volume.capacity.free)} free of ${formatBytes(volume.capacity.total)}`
              : 'Capacity unavailable'}
          </span>
        </span>
      </label>
      {!trackable && (
        <div className="volume-custom-required">
          <span className="muted small">This drive needs a folder path inspected before tracking.</span>
          <button type="button" className="link" onClick={onFolder}>
            Enter a folder path
          </button>
        </div>
      )}
    </div>
  )
}
