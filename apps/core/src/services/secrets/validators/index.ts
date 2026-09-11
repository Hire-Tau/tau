import type { SecretValidator } from './types'
export type { SecretValidation, SecretValidator } from './types'

/** GitHub authentication is owned by integration connections. */
export function isGitHubTokenKey(_key: string): boolean {
  return false
}

/** Extension point for save-time validators of non-integration secrets. */
export function getSecretValidator(_key: string): SecretValidator | undefined {
  return undefined
}
