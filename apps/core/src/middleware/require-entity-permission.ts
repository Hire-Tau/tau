import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { getAccessibleSquadIds, hasPermission, identityUserId, isUserlessAgentIdentity } from '../services/rbac'
import type { Identity } from '../services/rbac'

/**
 * Middleware factory for "handler-scope" routes whose route param is an entity
 * id (not a squad id). Resolves the owning squad id from the entity via
 * `loadSquadId`, then checks `hasPermission` for that squad.
 *
 * Fails closed:
 * - No identity on context → 401.
 * - `loadSquadId` throws → 403 (can't determine squad).
 * - `loadSquadId` returns non-null squadId → scoped `hasPermission(identity, permission, squadId)`.
 * - `loadSquadId` returns null (squad-less entity, e.g. system-manager agent) →
 *   if `opts.loadOwnerUserId` resolves to the authenticated user's id, allow;
 *   a user-less agent identity is denied before unscoped RBAC can substitute
 *   its own squad; otherwise use unscoped system permission (admins may pass).
 * Sets `c.set('authzChecked', true)` once the guard runs for an authenticated identity,
 * including deny paths, so the runtime sentinel does not rewrite intentional 403s.
 */
export function requireEntityPermission(
  permission: string,
  loadSquadId: (c: Context) => Promise<string | null>,
  opts?: { loadOwnerUserId?: (c: Context) => Promise<string | null> }
) {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    let squadId: string | null | undefined
    try {
      squadId = await loadSquadId(c)
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (squadId === null && opts?.loadOwnerUserId) {
      let ownerUserId: string | null = null
      try {
        ownerUserId = await opts.loadOwnerUserId(c)
      } catch {
        ownerUserId = null
      }

      if (ownerUserId) {
        // Private owned entity (e.g. a user's system-manager): owner-only — not
        // even admins may access another user's private agent. The owner is the
        // user, or that user's own agent token (which carries their userId).
        const callerUserId = identityUserId(identity)
        if (callerUserId === ownerUserId) return next()
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    if (squadId === null && isUserlessAgentIdentity(identity)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // squadId === null means a squad-less entity (e.g. system-manager/artifact-builder agent).
    // Fall back to a system-scope check (no squadId arg) so admins (*) and holders of a
    // system-scoped permission are still allowed through.
    const allowed =
      squadId === null ? await hasPermission(identity, permission) : await hasPermission(identity, permission, squadId)

    if (!allowed) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  })
}

/**
 * Helper for filtered-list GETs: returns only rows whose squad id is in the
 * set accessible to the identity.
 *
 * - If `getAccessibleSquadIds` returns `'all'`, all rows are returned.
 * - Otherwise, rows whose `getSquadId(row)` returns null are excluded (fail
 *   closed — squad-less rows are not surfaced to non-'all' callers).
 */
export async function filterToAccessibleSquads<T>(
  identity: Identity,
  rows: T[],
  getSquadId: (row: T) => string | null
): Promise<T[]> {
  const accessible = await getAccessibleSquadIds(identity)

  if (accessible === 'all') {
    return rows
  }

  const accessibleSet = new Set(accessible)
  return rows.filter((row) => {
    const squadId = getSquadId(row)
    if (squadId === null || squadId === undefined) return false
    return accessibleSet.has(squadId)
  })
}
