import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import { Hono } from 'hono'
import * as rbac from '../services/rbac'
import type { Identity } from '../services/rbac'

// We spy on the RBAC service functions so tests don't need a real DB.
let hasPermissionSpy: Mock<typeof rbac.hasPermission>
let getAccessibleSquadIdsSpy: Mock<typeof rbac.getAccessibleSquadIds>

beforeEach(() => {
  hasPermissionSpy = spyOn(rbac, 'hasPermission').mockResolvedValue(true)
  getAccessibleSquadIdsSpy = spyOn(rbac, 'getAccessibleSquadIds').mockResolvedValue('all')
})

afterEach(() => {
  hasPermissionSpy.mockRestore()
  getAccessibleSquadIdsSpy.mockRestore()
})

// Lazy import so spy is already in place before the module under test runs.
async function getHelpers() {
  const mod = await import('./require-entity-permission')
  return mod
}

const fakeIdentity: Identity = { type: 'legacy' }

// ── requireEntityPermission ──────────────────────────────────────────────────

describe('requireEntityPermission', () => {
  test('entity found + permitted → calls next() and sets authzChecked', async () => {
    const { requireEntityPermission } = await getHelpers()

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, fakeIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => 'squad-abc'),
      (c) => {
        const checked = c.get('authzChecked' as any)
        return c.json({ ok: true, authzChecked: checked })
      }
    )

    hasPermissionSpy.mockResolvedValue(true)

    const res = await app.request('/resource/ent-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.authzChecked).toBe(true)
    expect(hasPermissionSpy).toHaveBeenCalledWith(fakeIdentity, 'agents:read', 'squad-abc')
  })

  test('loadSquadId returns null + permitted identity → ALLOWED (system-scope check, next() called)', async () => {
    const { requireEntityPermission } = await getHelpers()

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, fakeIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => null),
      (c) => {
        const checked = c.get('authzChecked' as any)
        return c.json({ ok: true, authzChecked: checked })
      }
    )

    hasPermissionSpy.mockResolvedValue(true)

    const res = await app.request('/resource/squadless')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.authzChecked).toBe(true)
    // Called with no squadId (system-scope)
    expect(hasPermissionSpy).toHaveBeenCalledWith(fakeIdentity, 'agents:read')
  })

  test('user-less agent cannot use its own squad for a null-scope entity', async () => {
    const { requireEntityPermission } = await getHelpers()
    const identity: Identity = { type: 'agent', agentId: 'caller-agent', squadId: 'caller-squad' }
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, identity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => null),
      (c) => c.json({ ok: true })
    )

    hasPermissionSpy.mockResolvedValue(true)
    const res = await app.request('/resource/known-orphan')

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(hasPermissionSpy).not.toHaveBeenCalled()
  })

  test('loadSquadId returns null + unprivileged identity → 403', async () => {
    const { requireEntityPermission } = await getHelpers()

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, fakeIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => null),
      (c) => c.json({ ok: true })
    )

    hasPermissionSpy.mockResolvedValue(false)

    const res = await app.request('/resource/squadless-denied')
    expect(res.status).toBe(403)
  })

  test('squad-less entity owned by caller → calls next() without system-scope permission', async () => {
    const { requireEntityPermission } = await getHelpers()
    const ownerIdentity: Identity = { type: 'user', userId: 'user-owner' }

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, ownerIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => null, { loadOwnerUserId: async () => 'user-owner' }),
      (c) => c.json({ ok: true, authzChecked: c.get('authzChecked' as any) })
    )

    hasPermissionSpy.mockResolvedValue(false)

    const res = await app.request('/resource/squadless-owned')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.authzChecked).toBe(true)
    expect(hasPermissionSpy).not.toHaveBeenCalled()
  })

  test('squad-less entity owned by a different user → 403 (owner-exclusive, even with system permission)', async () => {
    const { requireEntityPermission } = await getHelpers()
    const callerIdentity: Identity = { type: 'user', userId: 'user-caller' }

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, callerIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => null, { loadOwnerUserId: async () => 'user-owner' }),
      (c) => c.json({ ok: true })
    )

    const res = await app.request('/resource/squadless-other-user')
    expect(res.status).toBe(403)
    // Owner-exclusive: a private owned entity is never reachable via a system-scope
    // permission (not even by admins), so the permission check is skipped entirely.
    expect(hasPermissionSpy).not.toHaveBeenCalled()
  })

  test('no identity → 401', async () => {
    const { requireEntityPermission } = await getHelpers()

    const app = new Hono()
    // No identity middleware — c.get('identity') returns undefined
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => 'squad-abc'),
      (c) => c.json({ ok: true })
    )

    const res = await app.request('/resource/ent-noauth')
    expect(res.status).toBe(401)
  })

  test('loadSquadId throws → 403 (fail closed)', async () => {
    const { requireEntityPermission } = await getHelpers()

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, fakeIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => {
        throw new Error('db error')
      }),
      (c) => c.json({ ok: true })
    )

    const res = await app.request('/resource/boom')
    expect(res.status).toBe(403)
  })

  test('entity in inaccessible squad → 403', async () => {
    const { requireEntityPermission } = await getHelpers()

    hasPermissionSpy.mockResolvedValue(false)

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('identity' as any, fakeIdentity)
      await next()
    })
    app.get(
      '/resource/:id',
      requireEntityPermission('agents:read', async () => 'squad-xyz'),
      (c) => c.json({ ok: true })
    )

    const res = await app.request('/resource/ent-2')
    expect(res.status).toBe(403)
  })
})

// ── filterToAccessibleSquads ─────────────────────────────────────────────────

describe('filterToAccessibleSquads', () => {
  interface Row {
    id: string
    squadId: string | null
  }

  const rows: Row[] = [
    { id: 'r1', squadId: 'squad-a' },
    { id: 'r2', squadId: 'squad-b' },
    { id: 'r3', squadId: null },
    { id: 'r4', squadId: 'squad-a' },
  ]

  test("'all' → returns all rows", async () => {
    const { filterToAccessibleSquads } = await getHelpers()
    getAccessibleSquadIdsSpy.mockResolvedValue('all')

    const result = await filterToAccessibleSquads(fakeIdentity, rows, (r) => r.squadId)
    expect(result).toHaveLength(4)
    expect(result.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  test('accessible squad list → only rows in that set', async () => {
    const { filterToAccessibleSquads } = await getHelpers()
    getAccessibleSquadIdsSpy.mockResolvedValue(['squad-a'])

    const result = await filterToAccessibleSquads(fakeIdentity, rows, (r) => r.squadId)
    expect(result.map((r) => r.id)).toEqual(['r1', 'r4'])
  })

  test('squad-less rows (null squadId) excluded for non-all callers', async () => {
    const { filterToAccessibleSquads } = await getHelpers()
    getAccessibleSquadIdsSpy.mockResolvedValue(['squad-a', 'squad-b'])

    const result = await filterToAccessibleSquads(fakeIdentity, rows, (r) => r.squadId)
    // r3 has null squadId — should NOT be included even though caller has squads
    expect(result.find((r) => r.id === 'r3')).toBeUndefined()
    expect(result.map((r) => r.id)).toEqual(['r1', 'r2', 'r4'])
  })

  test('passes identity to getAccessibleSquadIds', async () => {
    const { filterToAccessibleSquads } = await getHelpers()
    getAccessibleSquadIdsSpy.mockResolvedValue([])

    await filterToAccessibleSquads(fakeIdentity, rows, (r) => r.squadId)
    expect(getAccessibleSquadIdsSpy).toHaveBeenCalledWith(fakeIdentity)
  })
})
