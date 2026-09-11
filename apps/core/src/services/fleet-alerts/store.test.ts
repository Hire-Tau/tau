import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { SYSTEM_RECIPIENT_ID } from '@tau/shared'
import type { ProviderHealthRecord } from '@tau/shared/provider-health'
import { db } from '../../db'
import { agents, fleetIncidentNotifications, fleetIncidents, inbox, settings, squads } from '../../db/schema'
import { FleetIncidentNotifier } from './notifier'
import { observeDeadFleet, observeProvider, observeSandboxDegradation } from './store'

const WINDOW = 15 * 60 * 1000

describe('provider fleet incident store', () => {
  let provider: string
  let ownedProviders: string[]
  beforeEach(() => {
    provider = `provider-test-${crypto.randomUUID()}`
    ownedProviders = [provider]
  })
  afterEach(async () => {
    const incidentIds = (
      await db
        .select({ id: fleetIncidents.id })
        .from(fleetIncidents)
        .where(inArray(fleetIncidents.provider, ownedProviders))
    ).map((row) => row.id)
    if (incidentIds.length) {
      const inboxMessageIds = (
        await db
          .select({ id: fleetIncidentNotifications.inboxMessageId })
          .from(fleetIncidentNotifications)
          .where(inArray(fleetIncidentNotifications.incidentId, incidentIds))
      ).flatMap((row) => (row.id ? [row.id] : []))
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, incidentIds))
      if (inboxMessageIds.length) await db.delete(inbox).where(inArray(inbox.id, inboxMessageIds))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, incidentIds))
    }
  })

  const record = (since: Date, accountId?: string, providerId = provider): ProviderHealthRecord => ({
    provider: providerId,
    ...(accountId ? { accountId } : {}),
    kind: 'expired-oauth',
    message: 'OAuth refresh credential expired or was revoked.',
    since: since.getTime(),
  })
  const incidents = () => db.select().from(fleetIncidents).where(eq(fleetIncidents.provider, provider))
  async function notifications() {
    const rows = await incidents()
    if (!rows[0]) return []
    return db.select().from(fleetIncidentNotifications).where(eq(fleetIncidentNotifications.incidentId, rows[0].id))
  }

  test('isolates provider accounts by durable scope identity', async () => {
    const now = new Date('2026-08-17T12:00:00Z')
    await observeProvider({ status: 'unhealthy', record: record(now, 'a1'), now })
    await observeProvider({ status: 'unhealthy', record: record(now, 'a2'), now })
    expect(
      (await incidents())
        .map((row) => ({ accountId: row.accountId, scopeKey: row.scopeKey }))
        .sort((a, b) => a.accountId!.localeCompare(b.accountId!))
    ).toEqual([
      { accountId: 'a1', scopeKey: `provider:${provider}:account:a1` },
      { accountId: 'a2', scopeKey: `provider:${provider}:account:a2` },
    ])
  })

  test('is silent at exactly 15 minutes and alerts only when strictly older', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    await observeProvider({ status: 'unhealthy', record: record(since), now: new Date(since.getTime() + WINDOW) })
    expect(await notifications()).toEqual([])
    await observeProvider({
      status: 'unhealthy',
      record: record(since),
      now: new Date(since.getTime() + WINDOW + 1),
    })
    expect(await notifications()).toEqual([
      expect.objectContaining({
        audience: 'human',
        status: 'pending',
        nextAttemptAt: new Date(since.getTime() + WINDOW),
      }),
    ])
  })

  test('continuing failures preserve one incident and one alert', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    await observeProvider({
      status: 'unhealthy',
      record: record(since),
      now: new Date(since.getTime() + WINDOW + 1),
    })
    await observeProvider({
      status: 'unhealthy',
      record: record(since),
      now: new Date(since.getTime() + WINDOW + 60_000),
    })
    expect(await incidents()).toHaveLength(1)
    expect(await notifications()).toHaveLength(1)
  })

  test('short healthy recovery resolves silently', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    await observeProvider({ status: 'unhealthy', record: record(since, 'a1'), now: since })
    const now = new Date(since.getTime() + WINDOW - 1)
    await observeProvider({ status: 'healthy', provider, accountId: 'a1', now })
    const [incident] = await incidents()
    expect(incident.resolvedAt).toEqual(now)
    expect(await notifications()).toEqual([])
  })

  test('alerted recovery creates one recovery transition', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    await observeProvider({
      status: 'unhealthy',
      record: record(since, 'a1'),
      now: new Date(since.getTime() + WINDOW + 1),
    })
    const [incident] = await incidents()
    await new FleetIncidentNotifier().drain({ now: new Date(since.getTime() + WINDOW + 1), incidentIds: [incident.id] })
    await observeProvider({ status: 'healthy', provider, accountId: 'a1', now: new Date(since.getTime() + WINDOW + 2) })
    expect((await notifications()).map((row) => row.kind).sort()).toEqual(['alert', 'recovery'])
  })

  test('indeterminate observations do not change continuity', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    await observeProvider({ status: 'unhealthy', record: record(since, 'a1'), now: since })
    await observeProvider({ status: 'indeterminate', provider, accountId: 'a1', now: new Date(since.getTime() + 1000) })
    const [incident] = await incidents()
    expect(incident.startedAt).toEqual(since)
    expect(incident.lastObservedAt).toEqual(since)
  })

  test('concurrent first and threshold observations own one incident and alert', async () => {
    const since = new Date('2026-08-17T12:00:00Z')
    let releaseFirstLock!: () => void
    const firstLockGate = new Promise<void>((resolve) => (releaseFirstLock = resolve))
    let observeFirstLock!: () => void
    const firstLockObserved = new Promise<void>((resolve) => (observeFirstLock = resolve))
    let observeSecondTransaction!: () => void
    const secondTransactionObserved = new Promise<void>((resolve) => (observeSecondTransaction = resolve))
    let transactionCount = 0
    let lockOwnerCount = 0
    const adapter = {
      onTransactionStarted: () => {
        transactionCount++
        if (transactionCount === 2) observeSecondTransaction()
      },
      afterProviderLock: async () => {
        lockOwnerCount++
        if (lockOwnerCount === 1) observeFirstLock()
        await firstLockGate
      },
    }

    const input = { status: 'unhealthy' as const, record: record(since, 'a1'), now: since }
    const first = observeProvider(input, adapter)
    await firstLockObserved
    const second = observeProvider(input, adapter)
    await secondTransactionObserved
    const ownersBeforeFirstCommit = lockOwnerCount
    releaseFirstLock()
    const settled = await Promise.allSettled([first, second])

    expect(ownersBeforeFirstCommit).toBe(1)
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const ids = settled.map((result) => (result.status === 'fulfilled' ? result.value : undefined))
    expect(ids[0]).toBeDefined()
    expect(ids[1]).toBe(ids[0])
    expect(await incidents()).toHaveLength(1)

    await observeProvider({
      status: 'unhealthy',
      record: record(since, 'a1'),
      now: new Date(since.getTime() + WINDOW + 1),
    })
    expect(await notifications()).toHaveLength(1)
  })

  test('raw provider diagnostics cannot cross the incident persistence or notification boundary', async () => {
    const marker = `secret-token-${crypto.randomUUID()}`
    const since = new Date('2026-08-17T12:00:00Z')
    const unsafe = { ...record(since), message: `${marker} https://credentials.invalid?token=${marker}` }
    await observeProvider({ status: 'unhealthy', record: unsafe, now: new Date(since.getTime() + WINDOW + 1) })

    const [incident] = await incidents()
    expect(JSON.stringify(incident)).not.toContain(marker)
    expect(incident.causeSummary).toBe('Provider OAuth credentials expired or were revoked.')
    await new FleetIncidentNotifier().drain({ now: new Date(since.getTime() + WINDOW + 1), incidentIds: [incident.id] })
    const [message] = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `fleet-incident:${incident.id}:alert:human:system`))
    expect(JSON.stringify(message)).not.toContain(marker)
    expect(JSON.stringify(await db.select().from(settings))).not.toContain(marker)
    await db.delete(inbox).where(eq(inbox.idempotencyKey, `fleet-incident:${incident.id}:alert:human:system`))
  })
})

describe('dead fleet incident store ownership', () => {
  let squadId: string

  beforeEach(async () => {
    squadId = crypto.randomUUID()
    await db.insert(squads).values({
      id: squadId,
      name: `dead-fleet-store-${squadId}`,
      purpose: 'Dead fleet store test',
      status: 'active',
    })
  })

  afterEach(async () => {
    const incidentIds = (
      await db.select({ id: fleetIncidents.id }).from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
    ).map((row) => row.id)
    if (incidentIds.length) {
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, incidentIds))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, incidentIds))
    }
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  test('two concurrent reconcilers own one durable incident and alert', async () => {
    const firstDemandAt = new Date('2026-08-18T12:00:00Z')
    const alertAfter = new Date(firstDemandAt.getTime() + 30 * 60_000)
    const firstNow = new Date(alertAfter.getTime() + WINDOW + 60_000)
    const secondNow = new Date(firstNow.getTime() + 60_000)
    let releaseFirstLock!: () => void
    const firstLockGate = new Promise<void>((resolve) => (releaseFirstLock = resolve))
    let observeFirstLock!: () => void
    const firstLockObserved = new Promise<void>((resolve) => (observeFirstLock = resolve))
    let observeSecondTransaction!: () => void
    const secondTransactionObserved = new Promise<void>((resolve) => (observeSecondTransaction = resolve))
    let transactionCount = 0
    let lockOwnerCount = 0
    const adapter = {
      onTransactionStarted: () => {
        transactionCount++
        if (transactionCount === 2) observeSecondTransaction()
      },
      afterDeadFleetLock: async () => {
        lockOwnerCount++
        if (lockOwnerCount === 1) observeFirstLock()
        await firstLockGate
      },
    }
    const input = {
      status: 'stalled' as const,
      squadId,
      demandCount: 2,
      firstDemandAt,
    }

    const first = observeDeadFleet({ ...input, now: firstNow }, adapter)
    await firstLockObserved
    const second = observeDeadFleet({ ...input, now: secondNow }, adapter)
    await secondTransactionObserved
    const ownersBeforeFirstCommit = lockOwnerCount
    releaseFirstLock()
    const settled = await Promise.allSettled([first, second])

    expect(ownersBeforeFirstCommit).toBe(1)
    expect(transactionCount).toBe(2)
    expect(lockOwnerCount).toBe(2)
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    const ids = settled.map((result) => (result.status === 'fulfilled' ? result.value : undefined))
    expect(ids[0]).toBeDefined()
    expect(ids[1]).toBe(ids[0])
    const rows = await db.select().from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
    expect(rows).toHaveLength(1)
    const notifications = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, rows[0]!.id))
    const byAudience = new Map(notifications.map((row) => [row.audience, row]))
    expect(byAudience.get('manager')?.nextAttemptAt).toEqual(alertAfter)
    expect(byAudience.get('human')?.nextAttemptAt).toEqual(new Date(firstNow.getTime() + WINDOW))
  })
})

describe('sandbox degraded fleet incident store', () => {
  let ownedSandboxIds: string[]
  let ownedSquadIds: string[]

  beforeEach(async () => {
    ownedSandboxIds = []
    ownedSquadIds = []
  })

  async function managedSquad(managerStatus: 'idle' | 'dormant' = 'idle') {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `sandbox-routing-${squadId}`,
      purpose: 'Sandbox routing test',
      status: 'active',
    })
    const [manager] = await db
      .insert(agents)
      .values({
        agentTypeId: 'manager',
        squadId,
        status: managerStatus,
        dormantAt: managerStatus === 'dormant' ? new Date() : null,
      })
      .returning()
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    return { squadId, manager }
  }

  function sandboxId() {
    const id = `agent_${crypto.randomUUID()}`
    ownedSandboxIds.push(id)
    return id
  }

  async function rowsFor(id: string) {
    const [incident] = await db
      .select()
      .from(fleetIncidents)
      .where(eq(fleetIncidents.scopeKey, `sandbox:${id}`))
      .orderBy(fleetIncidents.createdAt)
    if (!incident) throw new Error(`Missing sandbox incident for ${id}`)
    const notifications = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, incident.id))
    return { incident, notifications }
  }

  afterEach(async () => {
    const scopeKeys = ownedSandboxIds.map((id) => `sandbox:${id}`)
    const incidents = scopeKeys.length
      ? await db
          .select({ id: fleetIncidents.id })
          .from(fleetIncidents)
          .where(inArray(fleetIncidents.scopeKey, scopeKeys))
      : []
    if (incidents.length) {
      await db.delete(fleetIncidentNotifications).where(
        inArray(
          fleetIncidentNotifications.incidentId,
          incidents.map((row) => row.id)
        )
      )
      await db.delete(fleetIncidents).where(
        inArray(
          fleetIncidents.id,
          incidents.map((row) => row.id)
        )
      )
    }
    if (ownedSquadIds.length) {
      await db.delete(agents).where(inArray(agents.squadId, ownedSquadIds))
      await db.delete(squads).where(inArray(squads.id, ownedSquadIds))
    }
  })

  test('does not inject a late manager row into an episode a pre-audience Core already alerted', async () => {
    const { squadId } = await managedSquad()
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    // Below the alert threshold: creates the incident without any delivery rows.
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 0,
      reasons: ['devbox_unavailable'],
      squadId,
      now,
    })
    // Exactly what a pre-audience Core wrote: one human alert, no audience awareness.
    const { incident } = await rowsFor(id)
    await db.insert(fleetIncidentNotifications).values({
      incidentId: incident.id,
      kind: 'alert',
      audience: 'human',
      status: 'pending',
      recipientId: SYSTEM_RECIPIENT_ID,
      idempotencyKey: `fleet-incident:${incident.id}:alert`,
      nextAttemptAt: now,
      updatedAt: now,
    })
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['devbox_unavailable'],
      squadId,
      now: new Date(now.getTime() + 1),
    })
    const { notifications } = await rowsFor(id)
    expect(notifications.map((row) => row.audience)).toEqual(['human'])
  })

  test('routes manager-remediable reasons manager-first from the third observation', async () => {
    const { squadId } = await managedSquad()
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    for (const attemptCount of [0, 1, 2, 3]) {
      await observeSandboxDegradation({
        status: 'degraded',
        sandboxId: id,
        attemptCount,
        reasons: ['devbox_unavailable'],
        squadId,
        now,
      })
    }
    const { notifications } = await rowsFor(id)
    expect(notifications.find((row) => row.audience === 'manager')).toMatchObject({
      status: 'pending',
      nextAttemptAt: now,
      recipientId: null,
      idempotencyKey: null,
    })
    expect(notifications.find((row) => row.audience === 'human')).toMatchObject({
      status: 'pending',
      nextAttemptAt: new Date(now.getTime() + WINDOW),
      recipientId: 'system',
    })
  })

  test('routes immediate, mixed, empty, and unknown reason sets to both audiences immediately', async () => {
    const { squadId } = await managedSquad()
    const cases = [
      ['git_credentials_unavailable'],
      ['devbox_unavailable', 'git_credentials_unavailable'],
      [],
      ['future_reason'],
      ['devbox_unavailable', 'future_reason'],
    ]
    for (const [index, reasons] of cases.entries()) {
      const id = sandboxId()
      const now = new Date(`2026-08-27T00:0${index}:00Z`)
      await observeSandboxDegradation({ status: 'degraded', sandboxId: id, attemptCount: 3, reasons, squadId, now })
      const { incident, notifications } = await rowsFor(id)
      expect(notifications.map((row) => row.nextAttemptAt.getTime())).toEqual([now.getTime(), now.getTime()])
      expect(JSON.stringify(incident.details)).not.toContain('future_reason')
    }
  })

  test('terminally skips a missing initial manager and does not revive it after assignment', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `sandbox-routing-${squadId}`,
      purpose: 'Sandbox missing manager test',
      status: 'active',
    })
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['devbox_unavailable'],
      squadId,
      now,
    })
    let current = await rowsFor(id)
    expect(current.notifications.find((row) => row.audience === 'manager')).toMatchObject({ status: 'skipped' })
    expect(current.notifications.find((row) => row.audience === 'human')).toMatchObject({ nextAttemptAt: now })

    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 4,
      reasons: ['devbox_unavailable'],
      squadId,
      now: new Date(now.getTime() + 1),
    })
    current = await rowsFor(id)
    expect(current.notifications.find((row) => row.audience === 'manager')).toMatchObject({ status: 'skipped' })

    await observeSandboxDegradation({ status: 'ready', sandboxId: id, now: new Date(now.getTime() + 2) })
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['devbox_unavailable'],
      squadId,
      now: new Date(now.getTime() + 3),
    })
    const episodes = await db
      .select()
      .from(fleetIncidents)
      .where(eq(fleetIncidents.scopeKey, `sandbox:${id}`))
      .orderBy(fleetIncidents.createdAt)
    const newRows = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, episodes.at(-1)!.id))
    expect(newRows.find((row) => row.audience === 'manager')).toMatchObject({ status: 'pending' })
  })

  test('accelerates only a still-pending human fallback when severity becomes immediate', async () => {
    const { squadId } = await managedSquad()
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['devbox_unavailable'],
      squadId,
      now,
    })
    const { incident } = await rowsFor(id)
    const acceleratedAt = new Date(now.getTime() + 60_000)
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 4,
      reasons: ['future_reason'],
      squadId,
      now: acceleratedAt,
    })
    let notifications = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, incident.id))
    const manager = notifications.find((row) => row.audience === 'manager')!
    const human = notifications.find((row) => row.audience === 'human')!
    expect(human.nextAttemptAt).toEqual(acceleratedAt)
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: now })
      .where(eq(fleetIncidentNotifications.id, manager.id))
    const notifier = new FleetIncidentNotifier()
    expect(await notifier.claimDue({ now: new Date(acceleratedAt.getTime() - 1), incidentIds: [incident.id] })).toEqual(
      []
    )
    expect(
      (await notifier.claimDue({ now: acceleratedAt, incidentIds: [incident.id] })).map((row) => row.audience)
    ).toEqual(['human'])

    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 5,
      reasons: ['git_credentials_unavailable'],
      squadId,
      now: new Date(acceleratedAt.getTime() + 60_000),
    })
    notifications = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, incident.id))
    expect(notifications.find((row) => row.audience === 'human')).toMatchObject({
      status: 'delivering',
      nextAttemptAt: acceleratedAt,
    })
  })

  test('skips invalid, inactive, terminated, cross-squad, and non-manager attribution', async () => {
    const now = new Date('2026-08-27T00:00:00Z')
    const invalidSquadIds: Array<string | undefined> = [undefined, 'malformed', crypto.randomUUID()]

    const createSquad = async (status: 'active' | 'paused' = 'active', archivedAt?: Date) => {
      const id = crypto.randomUUID()
      ownedSquadIds.push(id)
      await db.insert(squads).values({
        id,
        name: `sandbox-invalid-${id}`,
        purpose: 'Sandbox invalid attribution test',
        status,
        archivedAt,
      })
      return id
    }

    const paused = await createSquad('paused')
    const archived = await createSquad('active', now)
    const missingManager = await createSquad()
    invalidSquadIds.push(paused, archived, missingManager)

    const terminatedSquad = await createSquad()
    const [terminated] = await db
      .insert(agents)
      .values({ agentTypeId: 'manager', squadId: terminatedSquad, status: 'terminated', terminatedAt: now })
      .returning()
    await db.update(squads).set({ managerAgentId: terminated.id }).where(eq(squads.id, terminatedSquad))
    invalidSquadIds.push(terminatedSquad)

    const nonManagerSquad = await createSquad()
    const [engineer] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: nonManagerSquad }).returning()
    await db.update(squads).set({ managerAgentId: engineer.id }).where(eq(squads.id, nonManagerSquad))
    invalidSquadIds.push(nonManagerSquad)

    const crossSquad = await createSquad()
    const managerHome = await createSquad()
    const [foreignManager] = await db
      .insert(agents)
      .values({ agentTypeId: 'manager', squadId: managerHome })
      .returning()
    await db.update(squads).set({ managerAgentId: foreignManager.id }).where(eq(squads.id, crossSquad))
    invalidSquadIds.push(crossSquad)

    for (const [index, squadId] of invalidSquadIds.entries()) {
      const id = sandboxId()
      await observeSandboxDegradation({
        status: 'degraded',
        sandboxId: id,
        attemptCount: 3,
        reasons: ['devbox_unavailable'],
        ...(squadId ? { squadId } : {}),
        now: new Date(now.getTime() + index),
      })
      const { incident, notifications } = await rowsFor(id)
      expect(notifications.find((row) => row.audience === 'manager')).toMatchObject({ status: 'skipped' })
      expect(notifications.find((row) => row.audience === 'human')).toMatchObject({ status: 'pending' })
      if (!squadId || squadId === 'malformed' || !ownedSquadIds.includes(squadId)) expect(incident.squadId).toBeNull()
    }
  })

  test('keeps a dormant manager addressable for an explicitly wake-eligible fleet incident', async () => {
    const { squadId } = await managedSquad('dormant')
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['bashrc_unavailable'],
      squadId,
      now,
    })
    const { incident } = await rowsFor(id)

    const claims = await new FleetIncidentNotifier().claimDue({ now, incidentIds: [incident.id] })

    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ audience: 'manager', squadId })
  })

  test('claims delayed human escalation at exactly fifteen minutes', async () => {
    const { squadId } = await managedSquad()
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['bashrc_unavailable'],
      squadId,
      now,
    })
    const { incident } = await rowsFor(id)
    const notifier = new FleetIncidentNotifier()
    const managerClaims = await notifier.claimDue({ now, incidentIds: [incident.id] })
    expect(managerClaims.map((claim) => claim.audience)).toEqual(['manager'])
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: now })
      .where(eq(fleetIncidentNotifications.id, managerClaims[0]!.notificationId))
    expect(await notifier.claimDue({ now: new Date(now.getTime() + WINDOW - 1), incidentIds: [incident.id] })).toEqual(
      []
    )
    const humanClaims = await notifier.claimDue({
      now: new Date(now.getTime() + WINDOW),
      incidentIds: [incident.id],
    })
    expect(humanClaims.map((claim) => claim.audience)).toEqual(['human'])
  })

  test('resolves before escalation without creating human alert or recovery delivery', async () => {
    const { squadId } = await managedSquad()
    const id = sandboxId()
    const now = new Date('2026-08-27T00:00:00Z')
    await observeSandboxDegradation({
      status: 'degraded',
      sandboxId: id,
      attemptCount: 3,
      reasons: ['devbox_unavailable'],
      squadId,
      now,
    })
    const { incident } = await rowsFor(id)
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: now })
      .where(
        and(eq(fleetIncidentNotifications.incidentId, incident.id), eq(fleetIncidentNotifications.audience, 'manager'))
      )
    await observeSandboxDegradation({ status: 'ready', sandboxId: id, now: new Date(now.getTime() + WINDOW - 1) })
    const notifications = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, incident.id))
    expect(notifications.find((row) => row.kind === 'alert' && row.audience === 'human')).toMatchObject({
      status: 'canceled',
    })
    expect(notifications.some((row) => row.kind === 'recovery' && row.audience === 'human')).toBe(false)
    expect(notifications.find((row) => row.kind === 'recovery' && row.audience === 'manager')).toBeDefined()
  })
})
