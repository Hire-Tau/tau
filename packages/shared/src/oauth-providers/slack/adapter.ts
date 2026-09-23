import { SlackClient, SlackClientError, type SlackTokenResponse } from './client'
import { parseSlackConfiguration } from './config'
import type { OAuthProviderAdapter, OAuthProviderFailure, OAuthProviderGrant } from '../types'

const client = new SlackClient()

function grantFrom(token: SlackTokenResponse): OAuthProviderGrant {
  return {
    tokens: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
    },
    configuration: parseSlackConfiguration({
      version: 1,
      teamId: token.team.id,
      teamName: token.team.name,
      botUserId: token.botUserId,
      appId: token.appId,
    }),
    displayName: token.team.name?.trim().slice(0, 200) || 'Slack workspace',
  }
}

export function classifySlackError(error: unknown): OAuthProviderFailure {
  if (!(error instanceof SlackClientError)) return { code: 'provider_error', retryable: true }
  switch (error.code) {
    case 'invalid_grant':
    case 'invalid_auth':
    case 'unsupported_enterprise_install':
      return { code: error.code, retryable: false }
    case 'rate_limited':
      return {
        code: error.code,
        retryable: true,
        ...(error.providerRateLimited ? { providerRateLimited: true as const } : {}),
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      }
    case 'provider_timeout':
    case 'provider_unavailable':
      return { code: error.code, retryable: true }
    case 'invalid_response':
    case 'response_too_large':
      return { code: error.code, retryable: false }
    default:
      return { code: 'provider_error', retryable: true }
  }
}

export const slackAdapter: OAuthProviderAdapter = {
  key: 'slack',
  authorizeHosts: ['slack.com'],
  buildAuthorizationUrl: (input) => client.buildAuthorizationUrl(input),
  exchangeCode: async (input) => grantFrom(await client.exchangeCode(input)),
  refresh: async (input) => grantFrom(await client.refresh(input)),
  revoke: (input) => client.revoke(input),
  classifyError: classifySlackError,
}
