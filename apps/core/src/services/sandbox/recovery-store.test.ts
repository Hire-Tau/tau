import { afterEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, sandboxRecoveryEpisodes, sandboxRecoverySubscriptions } from '../../db/schema'
import { SandboxRecoveryStore } from './recovery-store'

const agentIds = new Set<string>()
const sandboxIds = new Set<string>()

afterEach(async () => {
  if (sandboxIds.size) {
    await db.delete(sandboxRecoveryEpisodes).where(inArray(sandboxRecoveryEpisodes.sandboxId, [...sandboxIds]))
  }
  if (agentIds.size) await db.delete(agents).where(inArray(agents.id, [...agentIds]))
  agentIds.clear()
  sandboxIds.clear()
})

async function createAgent(): Promise<string> {
  const id = crypto.randomUUID()
  agentIds.add(id)
  await db.insert(agents).values({ id, agentTypeId: `recovery-store-${id}` })
  return id
}

describe('SandboxRecoveryStore', () => {
  test('fails closed at malformed UUID and sandbox boundaries without PostgreSQL casts', async () => {
    const store = new SandboxRecoveryStore()
    const malformedAgentId = 'agent-test-non-uuid'
    const malformedSandboxId = 'not-a-sandbox'
    const validNeighborId = await createAgent()

    expect(await store.isWatched(malformedAgentId)).toBe(false)
    expect(await store.listWatching({ agentId: malformedAgentId })).toEqual([])
    expect(await store.claimDue({ agentId: malformedAgentId })).toEqual([])
    expect(await store.hasClosedEpisode(malformedSandboxId)).toBe(false)
    expect(await store.listWatching({ sandboxId: malformedSandboxId })).toEqual([])
    expect(await store.markDelivered(malformedAgentId, malformedAgentId, malformedAgentId)).toBe(false)
    expect(await store.closeEpisode(malformedAgentId, 'recovered')).toBe(false)
    await expect(
      store.register({ agentId: malformedAgentId, sandboxIds: [`agent_${validNeighborId}`] })
    ).rejects.toThrow('Invalid recovery agent ID')
    await expect(store.register({ agentId: validNeighborId, sandboxIds: [malformedSandboxId] })).rejects.toThrow(
      'Invalid recovery sandbox ID'
    )
    expect(await store.isWatched(validNeighborId)).toBe(false)

    const validSystemManagerSandbox = `system_manager_${crypto.randomUUID()}`
    sandboxIds.add(validSystemManagerSandbox)
    await store.register({ agentId: validNeighborId, sandboxIds: [validSystemManagerSandbox] })
    expect(await store.isWatched(validNeighborId)).toBe(true)
    // Mutation guard: removing agent validation makes PostgreSQL raise 22P02 on isWatched.
  })

  test('concurrent registration reuses one frozen episode and subscription', async () => {
    const agentId = await createAgent()
    const sandboxId = `agent_${crypto.randomUUID()}`
    sandboxIds.add(sandboxId)
    const observedAt = new Date('2026-08-14T00:00:00.000Z')

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new SandboxRecoveryStore().register({
          agentId,
          sandboxIds: [sandboxId],
          reason: 'OOMKilled',
          crash: true,
          observedAt,
        })
      )
    )

    const episodes = await db
      .select()
      .from(sandboxRecoveryEpisodes)
      .where(eq(sandboxRecoveryEpisodes.sandboxId, sandboxId))
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.generation).toBe(1)
    expect(episodes[0]?.startedAt).toEqual(observedAt)
    expect(new Set(results.flatMap((result) => result.registrations.map((row) => row.episodeId))).size).toBe(1)

    const subscriptions = await db
      .select()
      .from(sandboxRecoverySubscriptions)
      .where(eq(sandboxRecoverySubscriptions.agentId, agentId))
    expect(subscriptions).toHaveLength(1)
    expect(results.flatMap((result) => result.registrations).filter((row) => row.crashChargeWinner)).toHaveLength(1)
  })

  test('prepares one notification and grants one concurrent delivery claim', async () => {
    const agentId = await createAgent()
    const sandboxId = `agent_${crypto.randomUUID()}`
    sandboxIds.add(sandboxId)
    const store = new SandboxRecoveryStore()
    const registration = await store.register({ agentId, sandboxIds: [sandboxId] })
    const episodeId = registration.registrations[0]!.episodeId

    const prepared = await Promise.all(
      Array.from({ length: 8 }, () =>
        new SandboxRecoveryStore().prepareNotification({
          episodeId,
          agentId,
          kind: 'recovered',
          content: '[System] recovered',
          recordOnly: false,
          now: new Date('2026-08-14T00:01:00Z'),
        })
      )
    )
    expect(new Set(prepared.map((row) => row?.content))).toEqual(new Set(['[System] recovered']))

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        new SandboxRecoveryStore().claimDue({ agentId, now: new Date('2026-08-14T00:01:01Z') })
      )
    )
    expect(claims.flat()).toHaveLength(1)
    const claim = claims.flat()[0]!
    expect(await store.markDelivered(episodeId, agentId, claim.claimToken)).toBe(true)
    expect(await store.markDelivered(episodeId, agentId, crypto.randomUUID())).toBe(false)
  })

  test('stale registration racing recovery preparation cannot create a false next episode', async () => {
    const agentId = await createAgent()
    const otherAgentId = await createAgent()
    const staleAgentId = await createAgent()
    const sandboxId = `agent_${crypto.randomUUID()}`
    sandboxIds.add(sandboxId)
    const observedAt = new Date('2026-08-14T00:00:00Z')
    const store = new SandboxRecoveryStore()
    const first = await store.register({ agentId, sandboxIds: [sandboxId], observedAt })
    const episodeId = first.registrations[0]!.episodeId

    await Promise.all([
      store.prepareNotification({
        episodeId,
        agentId,
        kind: 'recovered',
        content: '[System] recovered',
        recordOnly: false,
        now: new Date('2026-08-14T00:01:00Z'),
      }),
      new SandboxRecoveryStore().register({ agentId: otherAgentId, sandboxIds: [sandboxId], observedAt }),
    ])

    await new SandboxRecoveryStore().register({ agentId: staleAgentId, sandboxIds: [sandboxId], observedAt })

    const episodes = await db
      .select()
      .from(sandboxRecoveryEpisodes)
      .where(eq(sandboxRecoveryEpisodes.sandboxId, sandboxId))
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.generation).toBe(1)
    expect(
      await db.select().from(sandboxRecoverySubscriptions).where(eq(sandboxRecoverySubscriptions.episodeId, episodeId))
    ).toHaveLength(3)
    // Mutation guard: using unrelated registration/preparation locks or always allocating after close creates generation 2.
  })

  test('normalizes a malformed crash count and still registers the durable watch', async () => {
    const agentId = await createAgent()
    const sandboxId = `agent_${crypto.randomUUID()}`
    sandboxIds.add(sandboxId)
    await db
      .update(agents)
      .set({ metadata: { sandboxRestartCount: 'invalid' } })
      .where(eq(agents.id, agentId))

    const result = await new SandboxRecoveryStore().register({ agentId, sandboxIds: [sandboxId], crash: true })
    expect(result.registrations).toHaveLength(1)
    expect(result.registrations[0]).toMatchObject({ crashChargeWinner: true, crashCount: 1 })
    const [agent] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId))
    expect((agent?.metadata as Record<string, unknown>).sandboxRestartCount).toBe(1)
    const subscriptions = await db
      .select()
      .from(sandboxRecoverySubscriptions)
      .where(eq(sandboxRecoverySubscriptions.agentId, agentId))
    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]?.crashCharged).toBe(true)
  })

  test('a later genuine outage receives a distinct generation', async () => {
    const agentId = await createAgent()
    const sandboxId = `agent_${crypto.randomUUID()}`
    sandboxIds.add(sandboxId)
    const store = new SandboxRecoveryStore()

    const first = await store.register({
      agentId,
      sandboxIds: [sandboxId],
      observedAt: new Date('2026-08-14T00:00:00Z'),
    })
    await store.closeEpisode(first.registrations[0]!.episodeId, 'recovered', new Date('2026-08-14T00:01:00Z'))
    const second = await store.register({
      agentId,
      sandboxIds: [sandboxId],
      observedAt: new Date('2026-08-14T00:02:00Z'),
    })

    expect(second.registrations[0]?.episodeId).not.toBe(first.registrations[0]?.episodeId)
    expect(second.registrations[0]?.generation).toBe(2)
  })
})
