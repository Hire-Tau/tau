import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, squads, workStreams } from '../../db/schema'
import { Agent } from '../../entities/Agent'

const squadIds: string[] = []
afterEach(async () => {
  for (const squadId of squadIds.splice(0)) {
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

async function makeSquad() {
  const [squad] = await db
    .insert(squads)
    .values({ name: `crew-dormancy-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  squadIds.push(squad.id)
  return squad
}

const lifecycleTarget = async (agentId: string) => {
  const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId))
  const meta = (row?.metadata ?? {}) as Record<string, unknown>
  return {
    target: meta.pendingLifecycleTarget ?? null,
    requestId: meta.pendingLifecycleRequestId ?? null,
    reason: meta.pendingLifecycleReason ?? null,
  }
}

describe('durable crew dormancy', () => {
  test('completing a stream commits a dormancy request for its worker crew', async () => {
    const squad = await makeSquad()
    const [engineer] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const stream = await storedLegacyWorkStream({
      squadId: squad.id,
      title: 'durable crew',
      agentIds: [engineer.id],
    })

    await stream.update({ status: 'done' })

    const request = await lifecycleTarget(engineer.id)
    expect(request.target).toBe('dormant')
    // Not optional: reconcileAgentLifecycleRequest returns early without a
    // string request id, so a target alone would be claimed by the sweep
    // forever, settle nothing, and never clear.
    expect(typeof request.requestId).toBe('string')
    expect(request.reason).toBe('work-stream-terminal')
  })

  test('the request survives a crash between commit and the post-commit cleanup', async () => {
    const squad = await makeSquad()
    const [engineer] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'crash', agentIds: [engineer.id] })

    // Simulate the process dying immediately after the commit: the stream is
    // durably terminal, but the post-commit teardown never ran. This is the
    // exact window that stranded 24 agents on the noah tenant.
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id))
    await db.transaction(async (tx) => {
      const { markCrewForDormancy } = await import('./crew-dormancy')
      await markCrewForDormancy(tx, [engineer.id])
    })

    // Nothing else ran. The durable request alone must be enough for the
    // already-scheduled pending sweep to finish the job.
    const { runPendingAgentLifecycleSweep } = await import('../agent/lifecycle')
    await runPendingAgentLifecycleSweep({ maxCandidates: 25 })

    const reloaded = await Agent.find(engineer.id, { eager: false })
    expect(reloaded?.status).toBe('dormant')
  })

  test('leaves managers and consultants alone, and honours persist', async () => {
    const squad = await makeSquad()
    const rows = await db
      .insert(agents)
      .values([
        { squadId: squad.id, agentTypeId: 'manager' },
        { squadId: squad.id, agentTypeId: 'consultant' },
        { squadId: squad.id, agentTypeId: 'engineer', persist: true },
        { squadId: squad.id, agentTypeId: 'reviewer' },
      ])
      .returning()
    const [manager, consultant, persistent, reviewer] = rows
    const stream = await storedLegacyWorkStream({
      squadId: squad.id,
      title: 'mixed crew',
      agentIds: rows.map((r) => r.id),
    })

    await stream.update({ status: 'done' })

    expect((await lifecycleTarget(manager.id)).target).toBeNull()
    expect((await lifecycleTarget(consultant.id)).target).toBeNull()
    expect((await lifecycleTarget(persistent.id)).target).toBeNull()
    // The one ordinary worker in the crew still gets its request.
    expect((await lifecycleTarget(reviewer.id)).target).toBe('dormant')
  })

  test('spares an agent still crewed on another open stream', async () => {
    const squad = await makeSquad()
    const [engineer] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const finishing = await storedLegacyWorkStream({ squadId: squad.id, title: 'finishing', agentIds: [engineer.id] })
    await storedLegacyWorkStream({ squadId: squad.id, title: 'still open', agentIds: [engineer.id] })

    await finishing.update({ status: 'done' })

    expect((await lifecycleTarget(engineer.id)).target).toBeNull()
  })

  test('does not downgrade an in-flight terminated request to dormant', async () => {
    const squad = await makeSquad()
    const [engineer] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    await db
      .update(agents)
      .set({
        metadata: {
          pendingLifecycleTarget: 'terminated',
          pendingLifecycleRequestId: 'pre-existing-request',
        },
      })
      .where(eq(agents.id, engineer.id))
    const stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'downgrade', agentIds: [engineer.id] })

    await stream.update({ status: 'done' })

    const request = await lifecycleTarget(engineer.id)
    expect(request.target).toBe('terminated')
    // Re-stamping a fresh id would orphan the in-flight request's CAS clear.
    expect(request.requestId).toBe('pre-existing-request')
  })

  test('cancelling a stream requests dormancy the same way', async () => {
    const squad = await makeSquad()
    const [engineer] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'cancelled', agentIds: [engineer.id] })

    await stream.cancel()

    expect((await lifecycleTarget(engineer.id)).target).toBe('dormant')
  })
})
