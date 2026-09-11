import type { OAuthProviderAdapter, OAuthProviderFailure } from '../types'
import { GitHubOAuthClient, GitHubOAuthError } from './client'

export function classifyGitHubOAuthError(error: unknown): OAuthProviderFailure {
  if (!(error instanceof GitHubOAuthError)) return { code: 'provider_error', retryable: true }
  return {
    code: error.code,
    retryable: ['provider_timeout', 'provider_unavailable', 'rate_limited', 'provider_error'].includes(error.code),
    ...(error.providerRateLimited ? { providerRateLimited: true as const } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  }
}

export function createGitHubAdapter(client = new GitHubOAuthClient()): OAuthProviderAdapter {
  return {
    key: 'github',
    authorizeHosts: ['github.com'],
    buildAuthorizationUrl: (input) => client.buildAuthorizationUrl(input),
    async exchangeCode(input) {
      const tokens = await client.exchangeCode(input)
      // Persist the token grant before any fallible identity lookup in Core.
      return { tokens, configuration: null, displayName: 'GitHub' }
    },
    async refresh(input) {
      // Refresh rotates the previous token pair and reports no identity. Do not
      // add fallible calls here: Core first persists this result, then validates
      // it against the saved account ID before granting runtime access.
      return { tokens: await client.refresh(input), configuration: null, displayName: 'GitHub' }
    },
    revoke: (input) => client.revoke(input),
    classifyError: classifyGitHubOAuthError,
  }
}

export const githubAdapter = createGitHubAdapter()
