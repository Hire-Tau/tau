export interface GitHubRepositoryAccess {
  status: 'verified' | 'missing' | 'unknown'
  personalAccountInstalled: boolean | null
  complete: boolean
  installations: {
    account: string
    repositoryCount: number | null
    contentsWrite: boolean
    workflowsWrite: boolean
    suspended: boolean
  }[]
}
