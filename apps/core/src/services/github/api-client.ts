import { resolveGitHubConnection } from '../integrations/github/resolve-connection'

const GITHUB_API_BASE = 'https://api.github.com'

export interface GitHubIssueApiLabel {
  name?: string | null
}

export interface GitHubIssueApiUser {
  login?: string | null
}

export interface GitHubIssueApiItem {
  number: number
  title: string
  body?: string | null
  html_url: string
  state: string
  labels?: GitHubIssueApiLabel[]
  user?: GitHubIssueApiUser | null
  updated_at: string
  created_at?: string
  pull_request?: unknown
}

export interface GitHubIssueApiComment {
  body?: string | null
  html_url?: string
  user?: GitHubIssueApiUser | null
  created_at: string
  updated_at: string
}

export async function githubApiGet<T>(path: string, squadId: string, connectionId?: string): Promise<T | null> {
  const token = (await resolveGitHubConnection(squadId, connectionId))?.credential.accessToken
  if (!token) return null
  const url = new URL(path, GITHUB_API_BASE)
  if (url.origin !== GITHUB_API_BASE) throw new Error('invalid_github_api_path')
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!res.ok) return null
  return (await res.json()) as T
}
