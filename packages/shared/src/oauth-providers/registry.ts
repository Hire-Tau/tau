import { notionAdapter } from './notion/adapter'
import { githubAdapter } from './github/adapter'
import type { OAuthProviderAdapter } from './types'

const ADAPTERS = new Map<string, OAuthProviderAdapter>([
  ['notion', notionAdapter],
  ['github', githubAdapter],
])

export function getOAuthProviderAdapter(key: string): OAuthProviderAdapter | undefined {
  return ADAPTERS.get(key)
}

export function oauthProviderKeys(): readonly string[] {
  return [...ADAPTERS.keys()].sort()
}

/** Registers a fake adapter for a test and returns a restoration callback. */
export function registerOAuthProviderAdapterForTest(adapter: OAuthProviderAdapter): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only')
  const previous = ADAPTERS.get(adapter.key)
  ADAPTERS.set(adapter.key, adapter)
  return () => {
    if (previous) ADAPTERS.set(adapter.key, previous)
    else ADAPTERS.delete(adapter.key)
  }
}

export { classifyNotionError } from './notion/adapter'
export { classifyGitHubOAuthError } from './github/adapter'
export type { OAuthProviderAdapter, OAuthProviderFailure, OAuthProviderGrant, OAuthProviderTokens } from './types'
