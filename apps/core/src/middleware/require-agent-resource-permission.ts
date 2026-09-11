import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  hasAgentResourcePermission,
  hasPermission,
  isUserlessAgentIdentity,
  type AgentResourceTarget,
  type Identity,
} from '../services/rbac'

/**
 * Requires permission for a loaded agent-owned resource. Missing targets and
 * loader failures are intentionally indistinguishable from inaccessible ones.
 * Global override is reserved for documented lifecycle operations.
 */
export function requireAgentResourcePermission(
  permission: string,
  loadTarget: (c: Context) => Promise<AgentResourceTarget | null>,
  opts: { allowGlobalOverride?: boolean } = {}
) {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    let target: AgentResourceTarget | null
    try {
      target = await loadTarget(c)
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (!target) return c.json({ error: 'Forbidden' }, 403)
    if (await hasAgentResourcePermission(identity, target, permission)) return next()
    if (opts.allowGlobalOverride && !isUserlessAgentIdentity(identity) && (await hasPermission(identity, permission))) {
      return next()
    }
    return c.json({ error: 'Forbidden' }, 403)
  })
}
