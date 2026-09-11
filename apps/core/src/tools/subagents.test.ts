import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, executions, schedules } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Subagent } from '../entities/Subagent'
import { createDispatchTool } from './dispatch'
import { createCheckSubagentsTool, createStopSubagentTool } from './subagents'

describe('subagent tools ownership scoping', () => {
  let agentTypeId: string
  let createdAgentIds: string[]

  beforeEach(async () => {
    agentTypeId = `subagent-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createdAgentIds = []
    await AgentType.create({
      id: agentTypeId,
      name: 'Subagent Tools Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    await AgentType.upsert({
      id: 'subagent',
      name: 'Subagent',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'subagent',
    })
  })

  afterEach(async () => {
    if (createdAgentIds.length) {
      await db.delete(schedules).where(inArray(schedules.scopeId, createdAgentIds))
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function createParent(): Promise<Agent> {
    const parent = await Agent.create({ agentTypeId, persist: true })
    createdAgentIds.push(parent.id)
    return parent
  }

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  }

  async function setChildActivity(
    subagentId: string,
    activityAt: Date,
    options: { terminated?: boolean; dormant?: boolean; resultStatus?: string } = {}
  ): Promise<void> {
    const child = await Agent.mustFind(subagentId)
    await db
      .update(agents)
      .set({
        status: options.terminated ? 'terminated' : options.dormant ? 'dormant' : 'idle',
        dormantAt: options.dormant ? activityAt : null,
        terminatedAt: options.terminated ? activityAt : null,
        updatedAt: activityAt,
        metadata: {
          ...(child.metadata ?? {}),
          ...(options.resultStatus ? { resultStatus: options.resultStatus } : {}),
        },
      })
      .where(eq(agents.id, subagentId))
  }

  it('documents the three subagent model choices and their exclusivity', () => {
    const dispatchTool = createDispatchTool({
      agentId: 'schema-test',
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: [] },
    })
    const itemProperties = (dispatchTool.parameters as any).properties.subagents.items.properties

    expect(itemProperties.inheritModel).toMatchObject({ type: 'boolean' })
    expect(itemProperties.model.description).toContain('explicit child model override')
    expect(itemProperties.inheritModel.description).toContain("parent's full resolved model fallback chain")
    expect(itemProperties.inheritModel.description).toContain('cannot be true when model is provided')
    expect(dispatchTool.description).toContain("defaults through the subagent's Standard tier")
    expect(dispatchTool.description).toContain('model provides an explicit child override')
    expect(dispatchTool.description).toContain(
      "inheritModel=true copies the parent's full resolved model fallback chain"
    )
    expect(dispatchTool.description).toContain('model and inheritModel=true cannot be combined')
  })

  it('dispatch uses the executing agent as parent and ignores caller-supplied parent ids', async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const dispatchTool = createDispatchTool({
      agentId: parent.id,
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
    })

    const result = await (
      dispatchTool.execute as unknown as (
        toolCallId: string,
        params: unknown
      ) => ReturnType<typeof dispatchTool.execute>
    )('tool-call-1', {
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'scoped child', label: 'scoped' }],
    })

    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const child = await Agent.mustFind(details.subagents[0].subagentId)
    createdAgentIds.push(child.id)

    expect(child.parentAgentId).toBe(parent.id)
    expect(child.parentAgentId).not.toBe(otherParent.id)
    expect(child.metadata).toMatchObject({
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
    })
  })

  it('check_subagents lists only the executing agent children', async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const { subagents: parentChildren } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'visible child', label: 'visible' }],
    })
    const { subagents: otherChildren } = await Subagent.dispatch({
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'hidden child', label: 'hidden' }],
    })
    createdAgentIds.push(parentChildren[0].subagentId, otherChildren[0].subagentId)

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-2', {})
    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const ids = details.subagents.map((child) => child.subagentId)

    expect(ids).toContain(parentChildren[0].subagentId)
    expect(ids).not.toContain(otherChildren[0].subagentId)
  })

  it('check_subagents hides old terminated subagents by default but keeps active and recent children newest-first', async () => {
    const parent = await createParent()
    const { subagents: children } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [
        { instructions: 'still running', label: 'active-old' },
        { instructions: 'recently done', label: 'recent-done' },
        { instructions: 'stale done', label: 'stale-done' },
      ],
    })
    createdAgentIds.push(...children.map((child) => child.subagentId))

    await setChildActivity(children[0].subagentId, daysAgo(30), { dormant: true })
    await setChildActivity(children[1].subagentId, daysAgo(1), { terminated: true, resultStatus: 'completed' })
    await setChildActivity(children[2].subagentId, daysAgo(14), { terminated: true, resultStatus: 'completed' })

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-recency-default', {})
    const details = result.details as { subagents: Array<{ subagentId: string; resultStatus: string | null }> }

    expect(details.subagents.map((child) => child.subagentId)).toEqual([children[1].subagentId, children[0].subagentId])
    expect(details.subagents[0].resultStatus).toBe('completed')
  })

  it('check_subagents honors recentWithinDays when widening the historical window', async () => {
    const parent = await createParent()
    const { subagents: children } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [
        { instructions: 'active historical', label: 'active-historical' },
        { instructions: 'within override', label: 'within-override' },
        { instructions: 'outside override', label: 'outside-override' },
      ],
    })
    createdAgentIds.push(...children.map((child) => child.subagentId))

    await setChildActivity(children[0].subagentId, daysAgo(60))
    await setChildActivity(children[1].subagentId, daysAgo(14), { terminated: true, resultStatus: 'completed' })
    await setChildActivity(children[2].subagentId, daysAgo(45), { terminated: true, resultStatus: 'completed' })

    const checkTool = createCheckSubagentsTool({ agentId: parent.id })
    const result = await (
      checkTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof checkTool.execute>
    )('tool-call-recency-override', { recentWithinDays: 30 })
    const details = result.details as { subagents: Array<{ subagentId: string }> }
    const ids = details.subagents.map((child) => child.subagentId)

    expect(ids).toContain(children[0].subagentId)
    expect(ids).toContain(children[1].subagentId)
    expect(ids).not.toContain(children[2].subagentId)
  })

  it("stop_subagent cannot stop another agent's child", async () => {
    const parent = await createParent()
    const otherParent = await createParent()
    const { subagents: otherChildren } = await Subagent.dispatch({
      parentAgentId: otherParent.id,
      subagents: [{ instructions: 'do not stop', label: 'other' }],
    })
    createdAgentIds.push(otherChildren[0].subagentId)

    const stopTool = createStopSubagentTool({ agentId: parent.id })
    await expect(
      (stopTool.execute as unknown as (toolCallId: string, params: unknown) => ReturnType<typeof stopTool.execute>)(
        'tool-call-3',
        { subagentId: otherChildren[0].subagentId, reason: 'not owner' }
      )
    ).rejects.toThrow('Subagent does not belong to parent')

    expect((await Agent.mustFind(otherChildren[0].subagentId)).terminatedAt).toBeNull()
  })
})
