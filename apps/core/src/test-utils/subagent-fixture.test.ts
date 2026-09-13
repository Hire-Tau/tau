import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, executions, modelTiers, schedules } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Subagent } from '../entities/Subagent'
import { acquireSubagentFixtureLock, SUBAGENT_FIXTURE_LOCK, SubagentTestFixture } from './subagent-fixture'

const chain = 'anthropic:claude-sonnet-4-5'
const fixtures: SubagentTestFixture[] = []
function fixture() {
  const value = new SubagentTestFixture('subagent-fixture', chain)
  fixtures.push(value)
  return value
}

afterEach(async () => {
  for (const value of fixtures.splice(0).reverse()) await value.cleanup()
})

describe('Subagent test fixture', () => {
  it('reaps every parent and descendant even when dispatch results are never registered', async () => {
    const value = fixture()
    await value.setup()
    const first = await Agent.create({ agentTypeId: value.parentTypeId })
    value.agentIds.push(first.id)
    const second = await Agent.create({ agentTypeId: value.parentTypeId })
    value.agentIds.push(second.id)
    const { subagents: children } = await Subagent.dispatch({
      parentAgentId: second.id,
      subagents: [{ instructions: 'second parent child' }],
    })
    const { subagents: grandchildren } = await Subagent.dispatch({
      parentAgentId: children[0].subagentId,
      subagents: [{ instructions: 'unregistered grandchild' }],
    })
    // Also cover a test throwing between Agent.create and recording the ID.
    const unregistered = await Agent.create({ agentTypeId: value.parentTypeId })
    const ids = [first.id, second.id, unregistered.id, children[0].subagentId, grandchildren[0].subagentId]
    await value.cleanup()
    expect(await db.select().from(agents).where(inArray(agents.id, ids))).toEqual([])
    expect(await db.select().from(executions).where(inArray(executions.agentId, ids))).toEqual([])
    expect(await db.select().from(schedules).where(inArray(schedules.scopeId, ids))).toEqual([])
    expect(await AgentType.find(value.parentTypeId)).toBeNull()
    expect(await db.select().from(modelTiers).where(eq(modelTiers.slug, value.tierSlug))).toEqual([])
  })

  it('restores the exact borrowed type, clears its cache, and never changes the Standard tier', async () => {
    const before = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    const standard = await db.select().from(modelTiers).where(eq(modelTiers.slug, 'standard'))
    const value = fixture()
    await value.setup()
    expect((await AgentType.mustFind('subagent')).tier).toBe(value.tierSlug)
    await value.cleanup()
    expect(await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))).toEqual(before)
    expect(await AgentType.find('subagent')).toEqual(before[0] ? new AgentType(before[0]) : null)
    expect(await db.select().from(modelTiers).where(eq(modelTiers.slug, 'standard'))).toEqual(standard)
  })

  it('serializes borrowers until restoration', async () => {
    const first = fixture()
    const second = fixture()
    await first.setup()
    const before = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    const pending = second.setup()
    try {
      // Observe the actual blocked advisory lock, not an arbitrary sleep or a
      // promise that merely has not resolved yet. The normal test budget applies.
      let blocked = false
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = ${Math.floor(SUBAGENT_FIXTURE_LOCK / 2 ** 32)}
            AND objid = ${SUBAGENT_FIXTURE_LOCK % 2 ** 32}
        `)
        if (rows.length) {
          blocked = true
          break
        }
        await Bun.sleep(1)
      }
      expect(blocked).toBe(true)
      expect(await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))).toEqual(before)
    } finally {
      await first.cleanup()
      await pending
    }
    expect((await AgentType.mustFind('subagent')).tier).toBe(second.tierSlug)
    await second.cleanup()
    expect((await AgentType.find('subagent'))?.tier).not.toBe(second.tierSlug)
  })

  it('restores an existing shared row instead of deleting it, including cached values', async () => {
    const release = await acquireSubagentFixtureLock()
    const before = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    let sentinel: typeof before
    try {
      await AgentType.upsert({
        id: 'subagent',
        name: 'Existing shared type',
        model: chain,
        systemPrompt: 'preserve me',
      })
      sentinel = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    } finally {
      await release()
    }
    const value = fixture()
    try {
      await value.setup()
      expect((await AgentType.mustFind('subagent')).tier).toBe(value.tierSlug)
      await value.cleanup()
      expect(await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))).toEqual(sentinel)
      expect(await AgentType.mustFind('subagent')).toEqual(new AgentType(sentinel[0]))
    } finally {
      await value.cleanup()
      const release = await acquireSubagentFixtureLock()
      try {
        if (before[0]) await db.update(agentTypes).set(before[0]).where(eq(agentTypes.id, 'subagent'))
        else await db.delete(agentTypes).where(eq(agentTypes.id, 'subagent'))
        AgentType.invalidateCache()
      } finally {
        await release()
      }
    }
  })

  it('restores shared state when setup throws after installing the borrowed type', async () => {
    const before = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    const failed = fixture()
    const original = AgentType.upsert
    const upsert = spyOn(AgentType, 'upsert').mockImplementationOnce(async (input) => {
      await original.call(AgentType, input)
      throw new Error('injected post-install failure')
    })
    try {
      await expect(failed.setup()).rejects.toThrow('injected post-install failure')
    } finally {
      upsert.mockRestore()
    }
    expect(await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))).toEqual(before)
    expect(await AgentType.find(failed.parentTypeId)).toBeNull()
    expect(await db.select().from(modelTiers).where(eq(modelTiers.slug, failed.tierSlug))).toEqual([])
  })

  it('cleans a partially initialized fixture and releases isolation after setup fails', async () => {
    const before = await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))
    const failed = fixture()
    const upsert = spyOn(AgentType, 'upsert').mockRejectedValueOnce(new Error('injected setup failure'))
    try {
      await expect(failed.setup()).rejects.toThrow('injected setup failure')
    } finally {
      upsert.mockRestore()
    }
    expect(await db.select().from(agentTypes).where(eq(agentTypes.id, 'subagent'))).toEqual(before)
    expect(await AgentType.find(failed.parentTypeId)).toBeNull()
    expect(await db.select().from(modelTiers).where(eq(modelTiers.slug, failed.tierSlug))).toEqual([])
    const next = fixture()
    await next.setup()
    await next.cleanup()
  })
})
