import { NotionClient, NotionClientError, type NotionTokenResponse } from './client'
import { parseNotionConfiguration } from './config'
import type { OAuthProviderAdapter, OAuthProviderFailure, OAuthProviderGrant } from '../types'

const client = new NotionClient()

function grantFrom(token: NotionTokenResponse): OAuthProviderGrant {
  return {
    tokens: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
    },
    configuration: parseNotionConfiguration({
      version: 1,
      workspaceId: token.workspaceId,
      workspaceName: token.workspaceName,
      workspaceIcon: token.workspaceIcon,
      botId: token.botId,
    }),
    displayName: token.workspaceName?.trim().slice(0, 200) || 'Notion workspace',
  }
}

export function classifyNotionError(error: unknown): OAuthProviderFailure {
  if (!(error instanceof NotionClientError)) return { code: 'provider_error', retryable: true }
  switch (error.code) {
    case 'invalid_grant':
    case 'invalid_auth':
    case 'workspace_identity_mismatch':
      return { code: error.code, retryable: false }
    case 'restricted_resource':
    case 'capability_or_resource_denied':
      return { code: 'capability_or_resource_denied', retryable: false }
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

export const notionAdapter: OAuthProviderAdapter = {
  key: 'notion',
  authorizeHosts: ['api.notion.com'],
  buildAuthorizationUrl: (input) => client.buildAuthorizationUrl(input),
  exchangeCode: async (input) => grantFrom(await client.exchangeCode(input)),
  refresh: async (input) => grantFrom(await client.refresh(input)),
  revoke: (input) => client.revoke(input),
  classifyError: classifyNotionError,
}
