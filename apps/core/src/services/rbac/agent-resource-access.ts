import { hasPermission } from './permissions'
import type { Identity } from './permissions'

export interface AgentResourceTarget {
  squadId: string | null
  ownerUserId: string | null
}

export function identityUserId(identity: Identity): string | null {
  if (identity.type === 'user') return identity.userId
  if (identity.type === 'agent') return identity.userId ?? null
  return null
}

export function isUserlessAgentIdentity(identity: Identity): boolean {
  return identity.type === 'agent' && !identity.userId
}

/**
 * Evaluates access to a resource owned by an agent. Squad scope takes
 * precedence over private ownership; private targets are owner-exclusive; and
 * user-less agent identities cannot substitute their own squad for an orphan.
 */
export async function hasAgentResourcePermission(
  identity: Identity,
  target: AgentResourceTarget | null,
  permission: string
): Promise<boolean> {
  if (!target) return false
  if (target.squadId) return hasPermission(identity, permission, target.squadId)
  if (target.ownerUserId) return identityUserId(identity) === target.ownerUserId
  if (isUserlessAgentIdentity(identity)) return false
  return hasPermission(identity, permission)
}
