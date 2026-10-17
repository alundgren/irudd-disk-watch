export type UpdatePhase =
  'unmanaged' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'
export type UpdateAction = 'check' | 'download' | 'install'
export type UpdateState = {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  message?: string
  retry?: UpdateAction
}
export type AppUpdateApi = {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  installAndRestart(): Promise<UpdateState>
  onState(listener: (state: UpdateState) => void): () => void
}
