import type { Identity } from './permissions'

/**
 * Stable audit label for `updatedBy`-style columns, derived from the
 * authenticated identity. Replaces hardcoded `'admin'` actors on credential /
 * setting writes so per-actor accountability is preserved.
 */
export function auditActor(identity: Identity | undefined): string {
  if (!identity) return 'system'
  switch (identity.type) {
    case 'user':
      return `user:${identity.userId}`
    case 'agent':
      // System-manager agents carry the delegating user; others audit as the agent.
      if (identity.userId) return `user:${identity.userId}`
      return `agent:${identity.agentId}`
    case 'legacy':
      return 'legacy'
    case 'system':
      return `system-token:${identity.systemTokenId}`
  }
}
