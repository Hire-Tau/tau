/** Commit-signing state of one GitHub connection, as the integration card shows it. */
export interface GitHubCommitSigningStatus {
  state: 'on' | 'off'
  /** `SHA256:…` fingerprint of the signing key, when on. */
  fingerprint?: string
  enabledAt?: string
  /** Live check that the key is still on the GitHub account; null when GitHub could not be asked. */
  registeredOnGitHub?: boolean | null
}

/** Why turning signing on failed; the card turns each into a fix-it message. */
export type GitHubCommitSigningErrorCode =
  | 'permission_missing'
  | 'connection_unusable'
  | 'key_rejected'
  | 'github_unavailable'
