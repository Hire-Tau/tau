import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { integrationEventPollingDispatches } from '../../db/schema'
import { DbEventPollingDispatchStore } from './db-event-polling-dispatch-store'

const providerKey = `dispatch-test-${crypto.randomUUID()}`

afterEach(async () => {
  await db
    .delete(integrationEventPollingDispatches)
    .where(eq(integrationEventPollingDispatches.providerKey, providerKey))
})

describe('DbEventPollingDispatchStore', () => {
  test('grants one concurrent logical-event lease and permanently records completion', async () => {
    const store = new DbEventPollingDispatchStore()
    const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(providerKey, 'same-event', 60_000)))
    const claimed = claims.filter((claim) => claim.status === 'claimed')
    expect(claimed).toHaveLength(1)
    expect(claims.filter((claim) => claim.status === 'busy')).toHaveLength(11)

    const leaseToken = (claimed[0] as { status: 'claimed'; leaseToken: string }).leaseToken
    await expect(store.complete(providerKey, 'same-event', crypto.randomUUID())).rejects.toThrow('lease lost')
    expect(await store.claim(providerKey, 'same-event', 60_000)).toEqual({ status: 'busy' })
    await store.complete(providerKey, 'same-event', leaseToken)

    expect(await store.claim(providerKey, 'same-event', 60_000)).toEqual({ status: 'completed' })
    const [row] = await db
      .select()
      .from(integrationEventPollingDispatches)
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, providerKey),
          eq(integrationEventPollingDispatches.eventKey, 'same-event')
        )
      )
    expect(row.completedAt).toBeInstanceOf(Date)
  })

  test('atomically records the first owner and deduplicates concurrent later owners', async () => {
    const store = new DbEventPollingDispatchStore()
    const firstSquad = crypto.randomUUID()
    const secondSquad = crypto.randomUUID()
    const thirdSquad = crypto.randomUUID()
    const claim = await store.claim(providerKey, 'owned-event', 60_000)
    if (claim.status !== 'claimed') throw new Error('expected claim')
    expect(
      (
        await db
          .select({ squadIds: integrationEventPollingDispatches.activitySquadIds })
          .from(integrationEventPollingDispatches)
          .where(eq(integrationEventPollingDispatches.eventKey, 'owned-event'))
      )[0].squadIds
    ).toEqual([])
    await store.complete(providerKey, 'owned-event', claim.leaseToken, {
      eventFact: { occurredAt: '2026-08-26T00:00:00.000Z' },
      eventOccurredAt: new Date('2026-08-26T00:00:00.000Z'),
      activitySquadId: firstSquad,
    })
    expect((await store.claim(providerKey, 'owned-event', 60_000)).status).toBe('completed')
    await Promise.all(
      [firstSquad, secondSquad, thirdSquad, secondSquad, firstSquad, thirdSquad].map((squadId) =>
        store.authorizeActivitySquad(providerKey, 'owned-event', squadId)
      )
    )
    const [row] = await db
      .select({ squadIds: integrationEventPollingDispatches.activitySquadIds })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.eventKey, 'owned-event'))
    expect(row.squadIds.sort()).toEqual([firstSquad, secondSquad, thirdSquad].sort())
  })

  test('grants nothing to busy, factless, mismatched, or legacy empty-owner rows', async () => {
    const store = new DbEventPollingDispatchStore()
    const squadId = crypto.randomUUID()
    await store.claim(providerKey, 'busy-owner', 60_000)
    await store.authorizeActivitySquad(providerKey, 'busy-owner', squadId)
    await db.insert(integrationEventPollingDispatches).values([
      { providerKey, eventKey: 'factless-owner', completedAt: new Date() },
      {
        providerKey,
        eventKey: 'legacy-empty-owner',
        completedAt: new Date(),
        eventFact: { occurredAt: '2026-08-26T00:00:00.000Z' } as any,
        eventOccurredAt: new Date('2026-08-26T00:00:00.000Z'),
      },
    ])
    await store.authorizeActivitySquad(providerKey, 'factless-owner', squadId)
    await store.authorizeActivitySquad('wrong-provider', 'legacy-empty-owner', squadId)
    await store.authorizeActivitySquad(providerKey, 'wrong-event', squadId)
    const before = await db
      .select({
        eventKey: integrationEventPollingDispatches.eventKey,
        squadIds: integrationEventPollingDispatches.activitySquadIds,
      })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.providerKey, providerKey))
    expect(before.find((row) => row.eventKey === 'busy-owner')?.squadIds).toEqual([])
    expect(before.find((row) => row.eventKey === 'factless-owner')?.squadIds).toEqual([])
    expect(before.find((row) => row.eventKey === 'legacy-empty-owner')?.squadIds).toEqual([])
    expect(await store.authorizeActivitySquad(providerKey, 'legacy-empty-owner', squadId)).toBe(false)
    const [legacy] = await db
      .select({ squadIds: integrationEventPollingDispatches.activitySquadIds })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.eventKey, 'legacy-empty-owner'))
    expect(legacy.squadIds).toEqual([])
  })

  test('atomically persists and returns an authoritative Activity fact', async () => {
    const store = new DbEventPollingDispatchStore()
    const claim = await store.claim(providerKey, 'fact-event', 60_000)
    if (claim.status !== 'claimed') throw new Error('expected claim')
    const [claimedRow] = await db
      .select({ activityId: integrationEventPollingDispatches.activityId })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.eventKey, 'fact-event'))
    expect(claimedRow.activityId).toMatch(/^[0-9a-f-]{36}$/)
    const occurredAt = new Date('2026-08-26T12:00:00.000Z')
    const eventFact = { occurredAt: occurredAt.toISOString(), action: 'closed' }
    const completed = await store.complete(providerKey, 'fact-event', claim.leaseToken, {
      eventFact,
      eventOccurredAt: occurredAt,
      activitySquadId: crypto.randomUUID(),
    })
    expect(completed).toMatchObject({ activityId: claimedRow.activityId, eventFact, eventOccurredAt: occurredAt })
    expect(completed && 'activityId' in completed).toBe(true)
    expect(await store.claim(providerKey, 'fact-event', 60_000)).toMatchObject({
      status: 'completed',
      dispatch: completed,
    })
  })

  test('makes an uncompleted event retryable after releasing its lease', async () => {
    const store = new DbEventPollingDispatchStore()
    const first = await store.claim(providerKey, 'retry-event', 60_000)
    expect(first.status).toBe('claimed')
    if (first.status !== 'claimed') throw new Error('expected dispatch claim')

    await store.release(providerKey, 'retry-event', first.leaseToken)

    expect((await store.claim(providerKey, 'retry-event', 60_000)).status).toBe('claimed')
  })

  test('reclaims a logical event after a pre-dispatch process crash expires its lease', async () => {
    const store = new DbEventPollingDispatchStore()
    expect((await store.claim(providerKey, 'crash-event', 1)).status).toBe('claimed')
    await Bun.sleep(10)
    expect((await store.claim(providerKey, 'crash-event', 60_000)).status).toBe('claimed')
  })
})
