import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, executions, modelTiers, schedules, users } from '../db/schema'
import { Agent } from './Agent'
import { AgentType } from './AgentType'
import { Execution } from './Execution'
import { Schedule } from './Schedule'
import { InboxMessage } from './InboxMessage'
import { SUBAGENT_WATCHDOG_KIND, Subagent } from './Subagent'
import {
  makeDormant,
  requestAgentLifecycle,
  runPendingAgentLifecycleSweep,
  setDormancyEffectHookForTest,
} from '../services/agent/lifecycle'

describe('Subagent.dispatch', () => {
  const standardChain = 'openai-codex:gpt-5.6-sol:medium,anthropic:claude-sonnet-5:high,zai:glm-5.3:high'
  let parentTypeId: string
  let createdIds: string[]
  let createdUserIds: string[]

  beforeEach(async () => {
    parentTypeId = `sub-parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createdIds = []
    createdUserIds = []
    await AgentType.create({
      id: parentTypeId,
      name: 'Sub Parent',
      model: 'openai-codex:gpt-5.6-sol:low',
      systemPrompt: 'parent',
    })
    await db
      .insert(modelTiers)
      .values({ slug: 'standard', label: 'Standard', chain: standardChain })
      .onConflictDoUpdate({ target: modelTiers.slug, set: { chain: standardChain } })
    await AgentType.upsert({
      id: 'subagent',
      name: 'Subagent',
      model: '',
      tier: 'standard',
      systemPrompt: 'base',
    })
  })

  afterEach(async () => {
    const parentId = createdIds[0] ?? '__none__'
    const children = await db.select({ id: agents.id }).from(agents).where(eq(agents.parentAgentId, parentId))
    const ids = [...createdIds, ...children.map((c) => c.id)]
    if (createdIds.length) await db.delete(schedules).where(inArray(schedules.scopeId, createdIds))
    if (ids.length) {
      await db.delete(executions).where(inArray(executions.agentId, ids))
      await db.delete(agents).where(inArray(agents.id, ids))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, parentTypeId))
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds))
  })

  it('rejects dispatch to an already terminated parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await parent.update({ terminatedAt: new Date() })
    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        subagents: [{ label: 'orphan', instructions: 'must not queue' }],
      })
    ).rejects.toThrow('is not live')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('converges dispatch racing parent termination without live orphan children', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await Promise.allSettled([
      Subagent.dispatch({
        parentAgentId: parent.id,
        subagents: [{ label: 'race', instructions: 'race termination' }],
      }),
      parent.update({ terminatedAt: new Date() }),
    ])
    const children = await Agent.list({ parentAgentId: parent.id })
    createdIds.push(...children.map((child) => child.id))
    expect((await Agent.mustFind(parent.id)).terminatedAt).toBeInstanceOf(Date)
    expect(children.filter((child) => !child.terminatedAt)).toHaveLength(0)
  })

  it('batch-creates subagents, queues first execution, and arms a watchdog', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)
    const result = await Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'A', label: 'A' }] })
    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.parentAgentId).toBe(parent.id)
    expect(child.agentTypeId).toBe('subagent')
    expect(child.persist).toBe(false)
    expect(await Subagent.countLive(parent.id)).toBe(1)

    const parentSchedules = await db.select().from(schedules).where(eq(schedules.scopeId, parent.id))
    expect(parentSchedules).toHaveLength(1)
    expect(parentSchedules[0].metadata).toEqual({ kind: 'subagent-watchdog' })
  })

  it('persists only normalized server-derived parent execution context', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      parentExecutionContext: {
        version: 1,
        squadId: null,
        environmentToolNames: ['read', 'bash', 'read'],
      },
      subagents: [{ instructions: 'inspect repository' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.metadata).toMatchObject({
      parentExecutionContext: {
        version: 1,
        squadId: null,
        environmentToolNames: ['bash', 'read'],
      },
    })
    expect(child.context).toEqual({})
    expect(JSON.stringify(child.metadata)).not.toMatch(/token|sandbox|\/home\//i)
  })

  it('rejects a parent execution context whose squad does not match the locked parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        parentExecutionContext: { version: 1, squadId: 'forged-squad', environmentToolNames: ['squad_bash'] },
        subagents: [{ instructions: 'inspect repository' }],
      })
    ).rejects.toThrow('squad')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('rejects malformed parent execution context metadata', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        parentExecutionContext: {
          version: 2,
          squadId: null,
          environmentToolNames: ['bash'],
        } as any,
        subagents: [{ instructions: 'inspect repository' }],
      })
    ).rejects.toThrow('Invalid parent execution context')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('copies owner identity so a solo child mints its own author-attributed token', async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: `subagent-owner-${crypto.randomUUID()}@test.local`, displayName: 'Subagent owner' })
      .returning()
    createdUserIds.push(owner.id)
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null, ownerUserId: owner.id })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
      subagents: [{ instructions: 'inspect repository' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.ownerUserId).toBe(owner.id)
    const parentToken = await parent.getOrCreateToken()
    const childToken = await child.getOrCreateToken()
    expect(childToken).toMatch(/^tau_agent_/)
    expect(childToken).not.toBe(parentToken)
  })

  it('compensates every child when a later queue fails and leaves no watchdog', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const originalQueue = Agent.prototype.queueExecution
    let queueCalls = 0
    const queue = spyOn(Agent.prototype, 'queueExecution').mockImplementation(async function (
      this: Agent,
      input: Parameters<Agent['queueExecution']>[0]
    ) {
      queueCalls += 1
      if (queueCalls === 2) throw new Error('injected second queue failure')
      return originalQueue.call(this, input)
    })
    try {
      await expect(
        Subagent.dispatch({
          parentAgentId: parent.id,
          subagents: [
            { label: 'first', instructions: 'first succeeds' },
            { label: 'second', instructions: 'second fails' },
          ],
        })
      ).rejects.toThrow('injected second queue failure')
    } finally {
      queue.mockRestore()
    }
    const children = await Agent.list({ parentAgentId: parent.id })
    createdIds.push(...children.map((child) => child.id))
    expect(children).toHaveLength(2)
    expect(children.every((child) => child.terminatedAt instanceof Date)).toBe(true)
    expect(await Subagent.countLive(parent.id)).toBe(0)
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      0
    )
  })

  it('leaves sweepable final requests when partial-dispatch teardown fails', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const originalQueue = Agent.prototype.queueExecution
    let queueCalls = 0
    const queue = spyOn(Agent.prototype, 'queueExecution').mockImplementation(async function (
      this: Agent,
      input: Parameters<Agent['queueExecution']>[0]
    ) {
      queueCalls += 1
      if (queueCalls === 2) throw new Error('injected queue failure')
      return originalQueue.call(this, input)
    })
    setDormancyEffectHookForTest(async (stage) => {
      if (stage === 'schedules') throw new Error('injected dormancy cleanup failure')
    })
    try {
      await expect(
        Subagent.dispatch({
          parentAgentId: parent.id,
          subagents: [
            { label: 'first', instructions: 'first' },
            { label: 'second', instructions: 'second' },
          ],
        })
      ).rejects.toThrow('injected queue failure')
    } finally {
      queue.mockRestore()
      setDormancyEffectHookForTest(undefined)
    }

    let children = await Agent.list({ parentAgentId: parent.id })
    createdIds.push(...children.map((child) => child.id))
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.status).toBe('dormant')
      expect(child.metadata).toMatchObject({
        pendingLifecycleTarget: 'terminated',
        pendingLifecycleRequestId: expect.any(String),
        dispatchCompensation: true,
      })
    }

    expect(await runPendingAgentLifecycleSweep({ maxCandidates: 1 })).toBe(1)
    expect(
      (await Agent.list({ parentAgentId: parent.id })).filter((child) => child.status === 'terminated')
    ).toHaveLength(1)
    expect(await runPendingAgentLifecycleSweep({ maxCandidates: 1 })).toBe(1)
    children = await Agent.list({ parentAgentId: parent.id })
    expect(children.every((child) => child.status === 'terminated')).toBe(true)
    expect(children.every((child) => child.metadata?.pendingLifecycleTarget === undefined)).toBe(true)
  })

  it('rotates a busy pending candidate so a later request is reached on the next capped tick', async () => {
    const stuck = await Agent.create({ agentTypeId: parentTypeId })
    const later = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(stuck.id, later.id)
    const episodeId = crypto.randomUUID()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          pendingLifecycleTarget: 'terminated',
          pendingLifecycleRequestId: crypto.randomUUID(),
          pendingLifecycleSweepAt: 0,
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, stuck.id))
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          pendingLifecycleTarget: 'dormant',
          pendingLifecycleRequestId: crypto.randomUUID(),
          pendingLifecycleSweepAt: 1,
        },
      })
      .where(eq(agents.id, later.id))

    expect(await runPendingAgentLifecycleSweep({ maxCandidates: 1 })).toBe(0)
    expect((await Agent.mustFind(stuck.id)).metadata).toHaveProperty('pendingLifecycleTarget')
    expect(await runPendingAgentLifecycleSweep({ maxCandidates: 1 })).toBe(1)
    expect(await Agent.mustFind(later.id)).toMatchObject({ status: 'dormant' })
    expect((await Agent.mustFind(later.id)).metadata).not.toHaveProperty('pendingLifecycleTarget')
  })

  it('replays durable stop intent and never downgrades a pending final request', async () => {
    const child = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(child.id)
    const execution = await child.queueExecution({ message: 'active lifecycle request' })
    await execution.update({ status: 'running' })
    await child.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    try {
      expect(
        await requestAgentLifecycle(child, {
          target: 'terminated',
          reason: 'final request',
          stopActive: true,
        })
      ).toBe(false)
      expect(await requestAgentLifecycle(child, { target: 'dormant', reason: 'stale weaker request' })).toBe(false)
      expect(await runPendingAgentLifecycleSweep()).toBe(0)
      expect(stop.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect((await Agent.mustFind(child.id)).metadata).toMatchObject({
        pendingLifecycleTarget: 'terminated',
        pendingLifecycleStopActive: true,
      })
    } finally {
      stop.mockRestore()
    }

    await execution.update({ status: 'stopped' })
    await child.update({ status: 'idle' })
    expect(await runPendingAgentLifecycleSweep()).toBe(1)
    expect(await Agent.mustFind(child.id)).toMatchObject({ status: 'terminated' })
    expect((await Agent.mustFind(child.id)).metadata).not.toHaveProperty('pendingLifecycleTarget')
  })

  it('uses the Standard tier without storing a child override by default', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'use defaults' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBeNull()
    expect(await child.getEffectiveModelSpec()).toBe(standardChain)
    expect(child.metadata).not.toHaveProperty('requestedModel')
    expect(child.metadata).not.toHaveProperty('inheritModel')
  })

  it('stores an explicit child override before any model is selected', async () => {
    const explicitChain = 'openai:gpt-5.3-codex'
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'use explicit model', model: explicitChain }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect((await child.mustGetAgentType()).tier).toBe('standard')
    expect(child.modelOverride).toBe(explicitChain)
    expect(child.selectedModel).toBeNull()
    expect(child.toJson()).toMatchObject({
      modelOverride: explicitChain,
      configuredModel: explicitChain,
    })
    expect(child.metadata).toMatchObject({ requestedModel: explicitChain })
    expect(child.metadata).not.toHaveProperty('inheritModel')
  })

  it('inherits the complete parent override instead of its selected model', async () => {
    const parentChain = 'openai-codex:gpt-5.6-sol:high,anthropic:claude-opus-5:high'
    const parent = await Agent.create({ agentTypeId: parentTypeId, modelOverride: parentChain })
    await db.update(agents).set({ selectedModel: 'anthropic:claude-opus-5:high' }).where(eq(agents.id, parent.id))
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'inherit override', inheritModel: true }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBe(parentChain)
    expect(child.metadata).toMatchObject({ inheritModel: true })
    expect(child.metadata).not.toHaveProperty('requestedModel')
  })

  it('inherits the full parent tier chain', async () => {
    await AgentType.upsert({
      id: parentTypeId,
      name: 'Sub Parent',
      model: '',
      tier: 'standard',
      systemPrompt: 'parent',
    })
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'inherit tier', inheritModel: true }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBe(standardChain)
    expect(child.metadata).toMatchObject({ inheritModel: true })
    expect(child.metadata).not.toHaveProperty('requestedModel')
  })

  it('rejects model with inheritModel=true atomically', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        subagents: [
          {
            instructions: 'invalid',
            model: 'anthropic:claude-opus-5:high',
            inheritModel: true,
          },
        ],
      })
    ).rejects.toThrow('model and inheritModel=true are mutually exclusive')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('revive clears prior result status without stale delivery metadata', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const { subagents } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'running', label: 'researcher' }],
    })
    const child = await Agent.mustFind(subagents[0].subagentId)
    await child.update({
      status: 'dormant',
      dormantAt: new Date(),
      metadata: { ...(child.metadata ?? {}), resultStatus: 'completed' },
    })

    await Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'continue' })

    const revived = await Agent.mustFind(child.id)
    expect(revived.terminatedAt).toBeNull()
    expect(revived.status).toBe('idle')
    expect(revived.metadata).toMatchObject({ resultStatus: null })
    expect(revived.metadata).not.toMatchObject({ conversational: true })
  })

  it('reports deferred revive while the child dormancy claim is busy', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          ...(child.metadata ?? {}),
          dormancyCompletionPending: true,
          dormancyCompletionId: crypto.randomUUID(),
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, child.id))

    await expect(
      Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'retry later' })
    ).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE', message: expect.stringContaining('retry shortly') })
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('never revives an irreversibly terminated child', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, child.id))

    await expect(
      Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'must stay historical' })
    ).rejects.toThrow('terminated')
    expect((await Agent.mustFind(child.id)).status).toBe('terminated')
  })

  it('stops active execution and returns stopped, then no-ops already terminated child', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const { subagents } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'running', label: 'runner' }],
    })
    const child = await Agent.mustFind(subagents[0].subagentId)
    const active = (await child.getActiveExecution()) as Execution

    const result = await Subagent.stop({ parentAgentId: parent.id, subagentId: child.id, reason: 'test stop' })

    expect(result.status).toBe('stopped')
    expect((await Execution.mustFind(active.id)).status).toBe('stopped')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
    expect((await Subagent.stop({ parentAgentId: parent.id, subagentId: child.id })).status).toBe('already-terminated')
  })

  it('reconcileWatchdog collapses duplicate watchdogs to exactly one while live children exist', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'running' }] })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-a',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-b',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })

    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      3
    )

    await Subagent.reconcileWatchdog(parent.id)

    const watchdogs = await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })
    expect(watchdogs).toHaveLength(1)
    expect(watchdogs[0].metadata).toEqual({ kind: SUBAGENT_WATCHDOG_KIND })
  })

  it('reconcileWatchdog preserves an automatically-disabled breaker projection', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await Subagent.reconcileWatchdog(parent.id)
    const [watchdog] = await Schedule.list({ scopeType: 'agent', scopeId: parent.id })
    const disabledAt = new Date()
    await db
      .update(schedules)
      .set({
        enabled: false,
        nextTriggerAt: null,
        automaticallyDisabledAt: disabledAt,
        automaticDisableReason: 'Automatically disabled after 10 consecutive transient failures.',
      })
      .where(eq(schedules.id, watchdog.id))

    await Subagent.reconcileWatchdog(parent.id)

    const reconciled = await Schedule.mustFind(watchdog.id)
    expect(reconciled).toMatchObject({ enabled: false, nextTriggerAt: null })
    expect(reconciled.automaticallyDisabledAt).toEqual(disabledAt)
  })

  it('reconcileWatchdog deletes all duplicate watchdogs when no live children remain', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-a',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-b',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })

    await Subagent.reconcileWatchdog(parent.id)

    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toEqual([])
  })

  it('making a parent dormant stops work and makes every child dormant', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)
    const execution = await child.queueExecution({ message: 'child work' })
    await Subagent.reconcileWatchdog(parent.id)
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      1
    )

    await parent.tryTerminate()

    expect((await Agent.mustFind(parent.id)).status).toBe('dormant')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
    expect((await Agent.mustFind(child.id)).terminatedAt).toBeNull()
    expect((await Agent.mustFind(grandchild.id)).status).toBe('dormant')
    expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toEqual([])
  })

  it('defers child teardown until an active worker authoritatively settles', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const execution = await child.queueExecution({ message: 'running child work' })
    await execution.update({ status: 'running' })
    await child.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    let childRevocations = 0
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (
      this: Agent,
      options?: Parameters<Agent['revokeTokensForAgent']>[0]
    ) {
      if (this.id === child.id) childRevocations++
      return originalRevoke.call(this, options)
    })
    try {
      await expect(parent.tryTerminate()).resolves.toBeUndefined()
      expect(await Agent.mustFind(parent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(child.id)).toMatchObject({
        status: 'active',
        pendingDormancyAt: expect.any(Date),
        metadata: expect.objectContaining({
          pendingLifecycleTarget: 'dormant',
          pendingLifecycleStopActive: true,
        }),
      })
      expect((await Execution.mustFind(execution.id)).status).toBe('running')
      expect(stop).toHaveBeenCalled()
      expect(childRevocations).toBe(0)
    } finally {
      stop.mockRestore()
      revoke.mockRestore()
    }
  })

  it('defers a three-level cascade when a busy grandchild leaves its dormant parent incomplete', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)
    const execution = await grandchild.queueExecution({ message: 'running grandchild work' })
    await execution.update({ status: 'running' })
    await grandchild.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    try {
      await expect(parent.tryTerminate()).resolves.toBeUndefined()
      expect(await Agent.mustFind(parent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(child.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(grandchild.id)).toMatchObject({
        status: 'active',
        metadata: expect.objectContaining({ pendingLifecycleTarget: 'dormant' }),
      })
      expect((await Execution.mustFind(execution.id)).status).toBe('running')
    } finally {
      stop.mockRestore()
    }
  })

  it('defers an already-dormant child whose completion claim is busy', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const completionId = crypto.randomUUID()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          ...(child.metadata ?? {}),
          dormancyCompletionPending: true,
          dormancyCompletionId: completionId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, child.id))

    await expect(Subagent.cascadeDormantChildren(parent.id, new Date())).resolves.toBe(false)
    expect(await Agent.mustFind(child.id)).toMatchObject({
      status: 'dormant',
      metadata: expect.objectContaining({ dormancyCompletionPending: true, dormancyCompletionId: completionId }),
    })
  })

  it('persists child dormancy intent before stopping work and fences racing admission', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const first = await child.queueExecution({ message: 'initial child work' })
    const originalStop = Execution.prototype.requestStopWithSignal
    let racingError: unknown
    const stopSpy = spyOn(Execution.prototype, 'requestStopWithSignal').mockImplementation(async function (
      this: Execution
    ) {
      const result = await originalStop.call(this)
      if (this.id === first.id && !racingError) {
        try {
          await child.queueExecution({ message: 'racing child work' })
        } catch (error) {
          racingError = error
        }
      }
      return result
    })
    try {
      await parent.tryTerminate()
    } finally {
      stopSpy.mockRestore()
    }

    expect(racingError).toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })
    expect(await Agent.mustFind(child.id)).toMatchObject({ status: 'dormant', dormantAt: expect.any(Date) })
    expect((await Execution.list({ agentId: child.id })).map(({ status }) => status)).toEqual(['stopped'])
  })

  it('retains parent and child dormancy completion until failed child teardown retries', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    let failChild = true
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (this: Agent) {
      if (this.id === child.id && failChild) throw new Error('injected child teardown failure')
      return originalRevoke.call(this)
    })
    try {
      await expect(parent.tryTerminate()).rejects.toThrow('Failed to make 1 subagent(s) dormant')
      expect((await Agent.mustFind(parent.id)).metadata).toMatchObject({ dormancyCompletionPending: true })
      expect((await Agent.mustFind(child.id)).metadata).toMatchObject({ dormancyCompletionPending: true })
      failChild = false
      await makeDormant(await Agent.mustFind(parent.id))
    } finally {
      revoke.mockRestore()
    }

    expect((await Agent.mustFind(parent.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    expect((await Agent.mustFind(child.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('generic parent termination cascades through nested descendants', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)

    await parent.update({ terminatedAt: new Date() })

    expect((await Agent.mustFind(child.id)).terminatedAt).toBeInstanceOf(Date)
    expect((await Agent.mustFind(grandchild.id)).terminatedAt).toBeInstanceOf(Date)
  })

  it('continues cascading later siblings and propagates a child finalization failure', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const first = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const second = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, first.id, second.id)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (this: Agent) {
      if (this.id === first.id) throw new Error('injected child failure')
      return originalRevoke.call(this)
    })
    try {
      await expect(Subagent.cascadeStopChildren(parent.id)).rejects.toThrow(
        'Failed to finalize one or more descendants'
      )
    } finally {
      revoke.mockRestore()
    }
    expect(await Agent.mustFind(first.id)).toMatchObject({
      status: 'dormant',
      metadata: expect.objectContaining({ dormancyCompletionPending: true }),
    })
    expect(await Agent.mustFind(second.id)).toMatchObject({ status: 'terminated', terminatedAt: expect.any(Date) })
  })

  it('stops a child without delivering to an already terminated parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, parent.id))
    const send = spyOn(InboxMessage, 'send')
    try {
      await expect(Subagent.stop({ parentAgentId: parent.id, subagentId: child.id })).resolves.toEqual({
        status: 'stopped',
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      send.mockRestore()
    }
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('errors atomically when over the cap and excludes terminated children from live count', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: Array.from({ length: 10 }, (_, i) => ({ instructions: `t${i}` })),
    })
    await expect(
      Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'overflow' }] })
    ).rejects.toThrow(/slots free/)
    expect(await Subagent.countLive(parent.id)).toBe(10)
  })
})
