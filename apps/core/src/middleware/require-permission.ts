import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { hasAnyPermission, hasAnySlotCleanupPermission, hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'
import { Squad } from '../entities/Squad'
import { AmbiguousPrefixError } from '../db/prefix-match'

/**
 * The full squad id behind a route param, which may be a short id prefix (`Squad.find` accepts the
 * first 8 characters, as `GET /api/squads/:id` and the env routes do).
 *
 * Guards MUST resolve before asking about permissions. A squad-scoped role REPLACES the
 * `squad_default` tier, so a user whose default grants a permission and whose role on THIS squad
 * withholds it is correctly denied for the full id — and, if the guard asked about the raw prefix,
 * would have been granted, because a prefix matches no `squad_id` and the override is invisible.
 * The check must name the same squad the handler will act on.
 *
 * Returns null when the param identifies no single squad (unknown, or an ambiguous prefix); the
 * caller turns that into 404, since there is no squad to be authorized against.
 */
async function resolveSquadParam(squadIdParam: string): Promise<string | null> {
  try {
    return (await Squad.find(squadIdParam))?.id ?? null
  } catch (error) {
    // An ambiguous prefix names several squads; it authorizes none of them.
    if (error instanceof AmbiguousPrefixError) return null
    throw error
  }
}

/**
 * Resolves the param and, on success, stashes it for the handler, which would otherwise repeat the
 * lookup. Returns the resolved squad id, or null for the caller to turn into a 404.
 */
async function resolvedSquadFor(c: Context, squadIdParam: string): Promise<string | null> {
  const resolved = await resolveSquadParam(squadIdParam)
  if (resolved) c.set('squadId', resolved)
  return resolved
}

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
    const squadIdParam = c.req.param(paramName)
    if (!squadIdParam) return c.json({ error: 'Squad ID required' }, 400)
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const squadId = await resolvedSquadFor(c, squadIdParam)
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)
    return (await hasAnyPermission(identity, permissions, squadId)) ? next() : c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireAnySquadCleanupPermission(permissions: string[], paramName = 'squadId') {
  return createMiddleware(async (c, next) => {
    const squadIdParam = c.req.param(paramName)
    if (!squadIdParam) return c.json({ error: 'Squad ID required' }, 400)
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const squadId = await resolvedSquadFor(c, squadIdParam)
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)
    return (await hasAnySlotCleanupPermission(identity, permissions, squadId))
      ? next()
      : c.json({ error: 'Forbidden' }, 403)
  })
}

export function requireSquadPermission(permission: string, paramName?: string) {
  return createMiddleware(async (c, next) => {
    const squadIdParam = paramName ? c.req.param(paramName) : c.req.param('id') || c.req.param('squadId')
    if (!squadIdParam) {
      return c.json({ error: 'Squad ID required' }, 400)
    }
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    const squadId = await resolvedSquadFor(c, squadIdParam)
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)
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
