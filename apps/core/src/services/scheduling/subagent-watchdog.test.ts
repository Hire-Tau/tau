import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, schedules, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { InboxMessage } from '../../entities/InboxMessage'
import { Schedule } from '../../entities/Schedule'
import { Subagent } from '../../entities/Subagent'
import { Squad } from '../../entities/Squad'

describe('subagent watchdog delivery', () => {
  let agentTypeId: string
  let agentIds: string[]
  let squadId: string

  beforeEach(async () => {
    agentTypeId = `watchdog-${crypto.randomUUID()}`
    agentIds = []
    await AgentType.create({ id: agentTypeId, name: 'Watchdog test', model: 'test', systemPrompt: 'test' })
    squadId = (await Squad.create({ name: agentTypeId, purpose: 'Watchdog test' })).id
  })

  afterEach(async () => {
    if (agentIds.length) {
      await db.delete(schedules).where(inArray(schedules.scopeId, agentIds))
      await db.delete(executions).where(inArray(executions.agentId, agentIds))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  async function createAgent(label: string, parentAgentId?: string): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId, parentAgentId, metadata: { label }, persist: true })
    agentIds.push(agent.id)
    return agent
  }

  async function tick(schedule: Schedule): Promise<void> {
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(0) })
      .where(eq(schedules.id, schedule.id))
    expect(await schedule.triggerIfDue()).toBe(true)
  }

  it.each(['system key', 'legacy metadata'])(
    'sends fresh scoped statuses on every %s watchdog tick',
    async (identity) => {
      const parent = await createAgent('parent')
      const child = await createAgent('first child', parent.id)
      await Subagent.reconcileWatchdog(parent.id)
      const [schedule] = await Schedule.list({ scopeType: 'agent', scopeId: parent.id })
      // Existing deployments have the old literal body. Delivery must not depend
      // on reconciliation rewriting it or on a newer systemKey being present.
      await db
        .update(schedules)
        .set({
          systemKey: identity === 'legacy metadata' ? null : schedule.systemKey,
          metadata: identity === 'system key' ? {} : { kind: 'subagent-watchdog' },
          action: {
            type: 'inbox_message',
            target: { type: 'agent', agentId: parent.id },
            subject: 'Subagent watchdog',
            content: 'check_subagents',
          },
        })
        .where(eq(schedules.id, schedule.id))

      const laterChild = await createAgent('created after schedule', parent.id)
      const oldChild = await createAgent('old result', parent.id)
      const otherParent = await createAgent('other parent')
      const unrelatedChild = await createAgent('unrelated child', otherParent.id)
      const finishedAt = new Date()
      await db
        .update(agents)
        .set({
          status: 'terminated',
          terminatedAt: finishedAt,
          updatedAt: finishedAt,
          metadata: { label: 'first child', resultStatus: 'completed' },
        })
        .where(eq(agents.id, child.id))
      const oldAt = new Date(finishedAt.getTime() - 8 * 24 * 60 * 60_000)
      await db
        .update(agents)
        .set({ status: 'terminated', terminatedAt: oldAt, updatedAt: oldAt })
        .where(eq(agents.id, oldChild.id))

      await tick(schedule)
      const messages = await InboxMessage.listForRecipient('agent', parent.id, { includeRead: true })
      expect(messages).toHaveLength(1)
      expect(messages[0].subject).toBe('Subagent watchdog')
      expect(messages[0].content).toContain(
        `first child (${child.id}): terminated, result=completed, lastActivityAt=${finishedAt.toISOString()}`
      )
      expect(messages[0].content).toContain(`created after schedule (${laterChild.id}): idle`)
      expect(messages[0].content).not.toContain(oldChild.id)
      expect(messages[0].content).not.toContain(unrelatedChild.id)
      expect(messages[0].content).not.toContain('check_subagents')

      await db
        .update(agents)
        .set({ status: 'waiting-input', updatedAt: new Date() })
        .where(eq(agents.id, laterChild.id))
      await tick(schedule)
      const refreshed = await InboxMessage.listForRecipient('agent', parent.id, { includeRead: true })
      expect(refreshed).toHaveLength(2)
      const latest = refreshed.find((message) => message.id !== messages[0].id)!
      expect(latest.content).toContain(`created after schedule (${laterChild.id}): waiting-input`)
      expect(latest.content).not.toContain(`created after schedule (${laterChild.id}): idle`)
    }
  )

  it('reports no subagents if children disappear before a watchdog tick', async () => {
    const parent = await createAgent('parent')
    const child = await createAgent('child', parent.id)
    await Subagent.reconcileWatchdog(parent.id)
    const [schedule] = await Schedule.list({ scopeType: 'agent', scopeId: parent.id })
    await db.delete(agents).where(eq(agents.id, child.id))
    await tick(schedule)
    const messages = await InboxMessage.listForRecipient('agent', parent.id, { includeRead: true })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('No subagents.')
  })

  it('preserves ordinary schedule text even when it names the watchdog tool', async () => {
    const parent = await createAgent('parent')
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'Subagent watchdog',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
    })
    await tick(schedule)
    const messages = await InboxMessage.listForRecipient('agent', parent.id, { includeRead: true })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('check_subagents')
  })
})
