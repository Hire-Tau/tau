import { describe, test, expect } from 'bun:test'
import { Permissions } from '@tau/shared'
import { Hono } from 'hono'
import { requireAnySquadPermission } from './require-permission'

// Drift guard: permission strings referenced by route guards / role defaults
// must exist in the shared catalog. Guards take `permission: string`, so a typo
// or an unlisted permission compiles cleanly and silently never matches —
// this test catches catalog drift in CI.
test('requireAnySquadPermission accepts either requested permission and rejects neither', async () => {
  const app = new Hono()
  app.use('/:squadId', async (c, next) => {
    const scope = c.req.header('x-test-scope')
    if (scope) {
      c.set('identity', {
        type: 'system',
        systemTokenId: 'slot-guard-test',
        name: 'slot-guard-test',
        scopes: [scope],
      })
    }
    await next()
  })
  app.get('/:squadId', requireAnySquadPermission([Permissions.SLOTS_USE, Permissions.SLOTS_WRITE]), (c) =>
    c.json({ ok: true })
  )

  expect((await app.request('/squad', { headers: { 'x-test-scope': Permissions.SLOTS_USE } })).status).toBe(200)
  expect((await app.request('/squad', { headers: { 'x-test-scope': Permissions.SLOTS_WRITE } })).status).toBe(200)
  expect((await app.request('/squad', { headers: { 'x-test-scope': Permissions.SQUADS_READ } })).status).toBe(403)
  expect((await app.request('/squad')).status).toBe(401)
})

describe('permission catalog completeness', () => {
  const catalog = new Set<string>(Object.values(Permissions))

  const usedByGuardsOrRoles = [
    'agent-types:read',
    'agent-types:create',
    'agent-types:update',
    'agent-types:delete',
    'squad-presets:read',
    'squad-presets:create',
    'squad-presets:update',
    'squad-presets:delete',
    'channels:read',
    'channels:create',
    'channels:update',
    'channels:delete',
    'provider-auth:read',
    'provider-auth:write',
    'webhooks:read',
    'agents:update',
    'agents:delete',
    'squads:update',
    'schedules:create',
    'schedules:update',
    'schedules:delete',
    'schedules:trigger',
    'terminal:read',
    'terminal:write',
    'ai:extract',
    'ai:transcribe',
    'ai:tts',
    'system:restart',
    'system:cleanup',
    'slots:use',
    'slots:write',
  ]

  for (const perm of usedByGuardsOrRoles) {
    test(`catalog contains ${perm}`, () => {
      expect(catalog.has(perm)).toBe(true)
    })
  }
})
