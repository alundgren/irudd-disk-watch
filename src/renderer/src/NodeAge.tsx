import { useSyncExternalStore } from 'react'
import { formatAge } from '../../shared/age'
import { NodeIcon } from './NodeIcon'

let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()
function tick() {
  now = Date.now()
  for (const notify of listeners) notify()
}
function visibilityChanged() {
  clearInterval(timer)
  timer = undefined
  tick()
  if (document.visibilityState === 'visible') timer = setInterval(tick, 1000)
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', visibilityChanged)
    visibilityChanged()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }
}
const getNow = () => now

interface NodeAgeProps {
  createdAt: number | null
  lastWrittenAt: number | null
  folder: boolean
}

export function NodeAge(props: NodeAgeProps) {
  if (!props.createdAt && !props.lastWrittenAt) return <span className="node-age" />
  return <TimedAge {...props} />
}

function TimedAge({ createdAt, lastWrittenAt, folder }: NodeAgeProps) {
  const current = useSyncExternalStore(subscribe, getNow)
  const edited = formatAge(lastWrittenAt, current)
  const created = formatAge(createdAt, current)
  return (
    <span className="node-age">
      {edited && (
        <span
          className={`write-age${current - lastWrittenAt! < 86_400_000 ? ' recent' : ''}`}
          title={
            folder
              ? `Latest captured write in this folder or its scanned contents: ${edited} ago`
              : `Last captured write: ${edited} ago`
          }
          aria-label={`Last written ${edited} ago`}
        >
          <NodeIcon kind="edit" />
          {edited}
        </span>
      )}
      {created && (
        <span className="creation-age" title={`Created ${created} ago`} aria-label={`Created ${created} ago`}>
          <NodeIcon kind="created" />
          {created}
        </span>
      )}
    </span>
  )
}
