export interface GitHubAccessState {
  source: 'saved' | 'environment' | 'none'
  hasSavedRecord: boolean
  canSave: boolean
  message?: string
}

export interface GitHubAccessApi {
  getState(): Promise<GitHubAccessState>
  save(token: string): Promise<GitHubAccessState>
  clear(): Promise<GitHubAccessState>
}
