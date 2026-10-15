import type { Machine, VolumeDiscovery } from '../../shared/types'
import { canTrackVolume, volumeChoices } from './volumeChoice'

type Discovered = VolumeDiscovery & { machine: Machine }
export interface VolumeDiscoveryState {
  request: number
  loading: boolean
  discovery: Discovered | null
  selected: string | null
  error: string | null
}
export const initialDiscovery: VolumeDiscoveryState = {
  request: 0,
  loading: false,
  discovery: null,
  selected: null,
  error: null,
}
type Action =
  | { type: 'start' | 'invalidate'; request: number }
  | { type: 'received'; request: number; discovery: Discovered }
  | { type: 'failed' | 'inspection-error'; request: number; message: string }
  | { type: 'select'; request: number; id: string | null }

export function volumeDiscovery(state: VolumeDiscoveryState, action: Action): VolumeDiscoveryState {
  if (action.type === 'start' || action.type === 'invalidate')
    return { ...initialDiscovery, request: action.request, loading: action.type === 'start' }
  if (action.request !== state.request) return state
  if (action.type === 'received')
    return {
      ...state,
      loading: false,
      discovery: action.discovery,
      error: null,
      selected:
        volumeChoices(action.discovery.volumes, false).find(
          (volume) => volume.recommended && volume.kind !== 'system' && canTrackVolume(volume),
        )?.id ?? null,
    }
  if (action.type === 'failed' || action.type === 'inspection-error')
    return { ...state, loading: false, error: action.message }
  if (action.type === 'select')
    return {
      ...state,
      selected:
        action.id && state.discovery?.volumes.some((volume) => volume.id === action.id && canTrackVolume(volume))
          ? action.id
          : null,
    }
  return state
}
