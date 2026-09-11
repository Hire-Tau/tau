import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { hasAnyPermission, hasAnySlotCleanupPermission, hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'

export function requirePermission(permission: string) {
  return requireAnyPermission(permission)
}

export function requireAnyPermission(...permissions: string[]) {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    for (const permission of permissions) {
      if (await hasPermission(identity, permission)) {
        return next()
      }
    }
    return c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireAnySquadPermission(permissions: string[], paramName = 'squadId') {
  return createMiddleware(async (c, next) => {
    const squadId = c.req.param(paramName)
    if (!squadId) return c.json({ error: 'Squad ID required' }, 400)
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    return (await hasAnyPermission(identity, permissions, squadId)) ? next() : c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireAnySquadCleanupPermission(permissions: string[], paramName = 'squadId') {
  return createMiddleware(async (c, next) => {
    const squadId = c.req.param(paramName)
    if (!squadId) return c.json({ error: 'Squad ID required' }, 400)
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    return (await hasAnySlotCleanupPermission(identity, permissions, squadId))
      ? next()
      : c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireSquadPermission(permission: string, paramName?: string) {
  return createMiddleware(async (c, next) => {
    const squadId = paramName ? c.req.param(paramName) : c.req.param('id') || c.req.param('squadId')
    if (!squadId) {
      return c.json({ error: 'Squad ID required' }, 400)
    }
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const allowed = await hasPermission(identity, permission, squadId)
    if (!allowed) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  })
}

/**
 * Only restricts agent identities to their own resources. Users and legacy
 * identities pass through — their access is controlled by permission middleware.
 */
export function assertOwnResource(identity: Identity, resourceId: string, field: 'agentId' | 'squadId'): void {
  if (identity.type === 'agent') {
    const value = identity[field]
    if (value !== resourceId) {
      throw new HTTPException(403, { message: 'Forbidden' })
    }
  }
}
