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
 * Returns null when the param identifies no single squad (unknown, or an ambiguous prefix). That
 * is NOT an answer on its own — see {@link guardSquadScope}, which still runs the permission check
 * against system scope so the response cannot be used to tell existing ids from absent ones.
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
 * The shortest prefix a squad route will look up. `Squad.find` imposes no minimum, so a one-
 * character prefix is a legal lookup over 1/16th of the id space — a cheap way to probe for
 * squads. Every client forms short ids with `slice(0, 8)`, so nothing legitimate is refused.
 */
const MIN_SQUAD_ID_LENGTH = 8

/**
 * The squad-scoped guard shared by the three squad middlewares: resolve the route param to the
 * squad the handler will act on, authorize THAT squad, and decide the response.
 *
 * The order of the last two steps is the part that matters. Answering 404 for an id that resolves
 * to nothing, before asking about permissions, tells the caller which ids exist — and because
 * `Squad.find` accepts any prefix length, a principal with no permissions at all could walk the id
 * space one hex digit at a time (403 = resolved, 404 = did not). So an unresolvable id falls back
 * to the SYSTEM-scope floor: if that denies, the answer is 403, indistinguishable from a squad the
 * caller may not see. 404 is reserved for callers the floor already admits, who learn nothing from
 * it.
 *
 * Returns a response to send, or undefined to continue into the handler.
 */
async function guardSquadScope(
  c: Context,
  squadIdParam: string | undefined,
  check: (identity: Identity, squadId: string | undefined) => Promise<boolean>
): Promise<Response | undefined> {
  if (!squadIdParam) return c.json({ error: 'Squad ID required' }, 400)
  const identity: Identity | undefined = c.get('identity')
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  if (squadIdParam.length < MIN_SQUAD_ID_LENGTH) {
    return c.json({ error: `Squad ID must be at least ${MIN_SQUAD_ID_LENGTH} characters` }, 400)
  }

  const squadId = await resolveSquadParam(squadIdParam)
  // Stash for the handler, which would otherwise repeat the lookup.
  if (squadId) c.set('squadId', squadId)
  if (!(await check(identity, squadId ?? undefined))) return c.json({ error: 'Forbidden' }, 403)
  if (!squadId) return c.json({ error: 'Squad not found' }, 404)
  return undefined
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
    const response = await guardSquadScope(c, c.req.param(paramName), (identity, squadId) =>
      hasAnyPermission(identity, permissions, squadId)
    )
    return response ?? next()
  })
}

export function requireAnySquadCleanupPermission(permissions: string[], paramName = 'squadId') {
  return createMiddleware(async (c, next) => {
    const response = await guardSquadScope(c, c.req.param(paramName), (identity, squadId) =>
      // The cleanup variant is squad-bound by construction; with no squad to bind to, the floor is
      // the ordinary unscoped check, which only a system-scoped grant can pass.
      squadId === undefined
        ? hasAnyPermission(identity, permissions)
        : hasAnySlotCleanupPermission(identity, permissions, squadId)
    )
    return response ?? next()
  })
}

export function requireSquadPermission(permission: string, paramName?: string) {
  return createMiddleware(async (c, next) => {
    const squadIdParam = paramName ? c.req.param(paramName) : c.req.param('id') || c.req.param('squadId')
    const response = await guardSquadScope(c, squadIdParam, (identity, squadId) =>
      hasPermission(identity, permission, squadId)
    )
    return response ?? next()
  })
}

/** The squad id a squad guard resolved and authorized for this request. */
export function resolvedSquadId(c: Context): string {
  const squadId = c.get('squadId')
  if (!squadId) throw new Error('resolvedSquadId requires a squad-scoped permission guard on the route')
  return squadId
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
