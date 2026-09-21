import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { actionsRouter } from './actions'
import { aiExtractRouter } from './ai-extract'
import systemRouter from './system'
import { transcribeRouter } from './transcribe'
import { identityMiddleware } from '../middleware/identity'
import * as localEvents from '../lib/infra/local-events'
import { RESTART_EXIT_CODE, SYSTEM_RESTART_CHANNEL } from '../lib/infra/system-restart'
import { db, roleAssignments, roles, squads, users, workStreams, workStreamWaits } from '../db'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { subscribeToSquad } from '../services/squad/subscriptions'

const rbacPrefix = `b16-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function buildApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/api/actions', actionsRouter)
  app.route('/api/ai/extract', aiExtractRouter)
  app.route('/api/system', systemRouter)
  app.route('/api/transcribe', transcribeRouter)
  return app
}

const app = buildApp()
let admin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix })
  unprivileged = await createTestUser({ prefix: rbacPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('B16 broad route RBAC guards', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `b16-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await db.delete(workStreams).where(like(workStreams.title, `${testPrefix}%`))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(roleAssignments).where(like(roleAssignments.subjectId, `${rbacPrefix}%`))
    await db.delete(users).where(like(users.email, `${testPrefix}%`))
    await db.delete(roles).where(like(roles.slug, `${testPrefix}%`))
  })

  it('requires identity for pending actions', async () => {
    const res = await app.request('/api/actions/pending')
    expect(res.status).toBe(401)
  })

  it('filters pending actions to squads where the caller has actions:read', async () => {
    const [allowedSquad, deniedSquad] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Allowed`, purpose: 'Allowed squad', status: 'active' },
        { name: `${testPrefix} Denied`, purpose: 'Denied squad', status: 'active' },
      ])
      .returning()

    const inserted = await db
      .insert(workStreams)
      .values([
        { squadId: allowedSquad.id, title: `${testPrefix} Allowed review`, status: 'active' },
        { squadId: deniedSquad.id, title: `${testPrefix} Denied review`, status: 'active' },
      ])
      .returning()
    await db.insert(workStreamWaits).values(
      inserted.map((ws) => ({
        workStreamId: ws.id,
        type: 'review' as const,
        message: 'review pending',
      }))
    )

    const reader = await createTestUser({ prefix: testPrefix })
    const role = await createTestRole({ prefix: testPrefix, permissions: ['actions:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: allowedSquad.id })
    // The Action Center is per-user: items surface for squads the user can read (actions:read)
    // unless they muted that squad's decisions. The subscription here pins the loud end of the
    // scale so the assertion is about RBAC, not about attention defaults.
    await subscribeToSquad(allowedSquad.id, reader.id)

    const res = await app.request('/api/actions/pending', { headers: authHeaders(reader.token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ squadId: string; data: { squadName: string } }>
    expect(body.map((action) => action.squadId)).toContain(allowedSquad.id)
    expect(body.map((action) => action.squadId)).not.toContain(deniedSquad.id)
  })

  it('denies transcribe without ai:transcribe and lets an authorized caller reach validation', async () => {
    const denied = await app.request('/api/transcribe', {
      method: 'POST',
      headers: authHeaders(unprivileged.token),
      body: new FormData(),
    })
    expect(denied.status).toBe(403)

    const allowed = await app.request('/api/transcribe', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: new FormData(),
    })
    expect(allowed.status).toBe(400)
  })

  it('denies AI extract without ai:extract and lets an authorized caller reach validation', async () => {
    const denied = await app.request('/api/ai/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(unprivileged.token) },
      body: JSON.stringify({}),
    })
    expect(denied.status).toBe(403)

    const allowed = await app.request('/api/ai/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({}),
    })
    expect(allowed.status).toBe(400)
  })

  /**
   * Capture the exit the restart handler schedules (instead of letting it kill
   * the test runner) so its code and ordering can be asserted. Unrelated timers
   * (db pool, hono) are captured too and deliberately NEVER fired: only timers
   * scheduled AFTER the worker signal are fired, which both finds the exit and
   * proves it was scheduled after the signal (an exit scheduled before the
   * signal is never fired, so `exitSpy` stays at zero calls).
   */
  function captureRestartExit() {
    const originalSetTimeout = globalThis.setTimeout
    const scheduled: Array<() => void> = []
    let scheduledAtSignal = -1
    globalThis.setTimeout = ((fn: () => void) => {
      scheduled.push(fn)
      return 0
    }) as unknown as typeof setTimeout
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    return {
      exitSpy,
      markSignal: () => {
        scheduledAtSignal = scheduled.length
      },
      fireTimersScheduledAfterSignal: () => {
        expect(scheduledAtSignal).toBeGreaterThanOrEqual(0)
        for (const fn of scheduled.slice(scheduledAtSignal)) fn()
      },
      restore: () => {
        globalThis.setTimeout = originalSetTimeout
        exitSpy.mockRestore()
      },
    }
  }

  it('denies system restart without system:restart, and an authorized restart signals the worker then exits non-zero so systemd Restart=on-failure recovers', async () => {
    const denied = await app.request('/api/system/restart', {
      method: 'POST',
      headers: authHeaders(unprivileged.token),
    })
    expect(denied.status).toBe(403)

    // A clean exit(0) leaves a systemd `Restart=on-failure` unit DOWN — the
    // process dies and never returns — so the restart MUST exit non-zero. This
    // guards the incident where the in-UI restart button silently killed the
    // instance. And the worker is a separate unit the api's exit cannot reach,
    // so the handler must ALSO signal it over local-events, BEFORE scheduling
    // its own exit.
    const capture = captureRestartExit()
    const notifySpy = spyOn(localEvents, 'notify').mockImplementation(async () => capture.markSignal())
    try {
      const allowed = await app.request('/api/system/restart', {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toEqual({ restarting: true })

      expect(notifySpy).toHaveBeenCalledTimes(1)
      expect(notifySpy.mock.calls[0][0]).toBe(SYSTEM_RESTART_CHANNEL)

      capture.fireTimersScheduledAfterSignal()
      expect(capture.exitSpy).toHaveBeenCalledTimes(1)
      expect(capture.exitSpy.mock.calls[0][0]).not.toBe(0)
      expect(capture.exitSpy.mock.calls[0][0]).toBe(RESTART_EXIT_CODE)
    } finally {
      capture.restore()
      notifySpy.mockRestore()
    }
  })

  it('still restarts the api (200 + non-zero exit) when the worker restart signal fails', async () => {
    const capture = captureRestartExit()
    const notifySpy = spyOn(localEvents, 'notify').mockImplementation(async () => {
      capture.markSignal()
      throw new Error('worker unreachable')
    })
    try {
      const allowed = await app.request('/api/system/restart', {
        method: 'POST',
        headers: authHeaders(admin.token),
      })
      expect(allowed.status).toBe(200)
      expect(await allowed.json()).toEqual({ restarting: true })
      expect(notifySpy).toHaveBeenCalledTimes(1)

      capture.fireTimersScheduledAfterSignal()
      expect(capture.exitSpy).toHaveBeenCalledTimes(1)
      expect(capture.exitSpy.mock.calls[0][0]).not.toBe(0)
    } finally {
      capture.restore()
      notifySpy.mockRestore()
    }
  })
})
