import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, inbox, executions } from '../../db/schema'
import { turnHooks } from './registry'
import { registerBuiltinHooks } from './index'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import type { TurnContext, TurnHook } from './types'

describe('TurnHookRegistry', () => {
  beforeEach(() => {
    turnHooks.clear()
  })

  const makeContext = (overrides: Partial<TurnContext> = {}): TurnContext => ({
    agentId: 'agent-123',
    executionId: 'exec-456',
    response: 'test response',
    metadata: undefined,
    sessionUsage: {
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.001,
      },
      context: null,
    },
    ...overrides,
  })

  describe('register', () => {
    it('registers a hook', () => {
      const hook: TurnHook = async () => ({ action: 'continue' })
      turnHooks.register('test', 10, hook)
      expect(turnHooks.list()).toEqual(['test (priority: 10)'])
    })

    it('replaces hook with same name', () => {
      const hook1: TurnHook = async () => ({ action: 'continue' })
      const hook2: TurnHook = async () => ({ action: 'halt', status: 'waiting-input' })

      turnHooks.register('test', 10, hook1)
      turnHooks.register('test', 20, hook2)

      expect(turnHooks.list()).toEqual(['test (priority: 20)'])
    })

    it('sorts hooks by priority', () => {
      turnHooks.register('c', 30, async () => ({ action: 'continue' }))
      turnHooks.register('a', 10, async () => ({ action: 'continue' }))
      turnHooks.register('b', 20, async () => ({ action: 'continue' }))

      expect(turnHooks.list()).toEqual(['a (priority: 10)', 'b (priority: 20)', 'c (priority: 30)'])
    })
  })

  describe('unregister', () => {
    it('removes a hook by name', () => {
      turnHooks.register('test', 10, async () => ({ action: 'continue' }))
      turnHooks.unregister('test')
      expect(turnHooks.list()).toEqual([])
    })

    it('does nothing for unknown name', () => {
      turnHooks.register('test', 10, async () => ({ action: 'continue' }))
      turnHooks.unregister('unknown')
      expect(turnHooks.list()).toEqual(['test (priority: 10)'])
    })
  })

  describe('run', () => {
    it('returns continue when no hooks registered', async () => {
      const result = await turnHooks.run(makeContext())
      expect(result).toEqual({ action: 'continue' })
    })

    it('returns continue when all hooks continue', async () => {
      turnHooks.register('a', 10, async () => ({ action: 'continue' }))
      turnHooks.register('b', 20, async () => ({ action: 'continue' }))

      const result = await turnHooks.run(makeContext())
      expect(result).toEqual({ action: 'continue' })
    })

    it('returns first halt result', async () => {
      const calls: string[] = []

      turnHooks.register('a', 10, async () => {
        calls.push('a')
        return { action: 'continue' }
      })
      turnHooks.register('b', 20, async () => {
        calls.push('b')
        return { action: 'halt', status: 'waiting-input', updates: { questionData: { questions: [] } } }
      })
      turnHooks.register('c', 30, async () => {
        calls.push('c')
        return { action: 'continue' }
      })

      const result = await turnHooks.run(makeContext())

      expect(result).toEqual({
        action: 'halt',
        status: 'waiting-input',
        updates: { questionData: { questions: [] } },
      })
      // Hook c should not be called since b halted
      expect(calls).toEqual(['a', 'b'])
    })

    it('continues on hook error', async () => {
      turnHooks.register('failing', 10, async () => {
        throw new Error('hook error')
      })
      turnHooks.register('passing', 20, async () => ({ action: 'continue' }))

      const result = await turnHooks.run(makeContext())
      expect(result).toEqual({ action: 'continue' })
    })

    it('passes context to hooks', async () => {
      let receivedCtx: TurnContext | undefined

      turnHooks.register('capture', 10, async (ctx) => {
        receivedCtx = ctx
        return { action: 'continue' }
      })

      const ctx = makeContext({ agentId: 'my-agent', response: 'hello' })
      await turnHooks.run(ctx)

      expect(receivedCtx).toEqual(ctx)
    })
  })

  describe('clear', () => {
    it('removes all hooks', () => {
      turnHooks.register('a', 10, async () => ({ action: 'continue' }))
      turnHooks.register('b', 20, async () => ({ action: 'continue' }))
      turnHooks.clear()
      expect(turnHooks.list()).toEqual([])
    })
  })
})

describe('TurnHookRegistry integration', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let agent: Agent
  let agentId: string

  beforeEach(async () => {
    turnHooks.clear()
    testPrefix = `hook-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'Test prompt',
    })

    agent = await Agent.create({ agentTypeId: testAgentTypeId })
    agentId = agent.id

    // Register built-in hooks with their real priorities. inboxWakeHook is
    // intentionally disabled by default now that inbox delivery happens at
    // send time through Agent.sendMessage.
    registerBuiltinHooks()
  })

  afterEach(async () => {
    turnHooks.clear()

    const agentList = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const a of agentList) {
      await db.delete(executions).where(eq(executions.agentId, a.id))
      await db.delete(inbox).where(eq(inbox.recipientId, a.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  const makeContext = (): TurnContext => ({
    agentId,
    executionId: 'exec-456',
    response: 'test response',
    metadata: undefined,
    sessionUsage: {
      stats: {
        userMessages: 1,
        assistantMessages: 1,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0.001,
      },
      context: null,
    },
  })

  it('does not run inbox-wake by default when no pending questions', async () => {
    // No pending questions, but there's an undelivered unread inbox message.
    // The legacy inbox-wake hook is disabled by default; send-time inbox
    // delivery is responsible for waking/steering agents.
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agentId))

    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: 'You have a task to complete',
      })
      .returning()

    const result = await turnHooks.run(makeContext())

    expect(result.action).toBe('continue')

    const [undelivered] = await db.select().from(inbox).where(eq(inbox.id, message.id))
    expect(undelivered.deliveredAt).toBeNull()

    const queuedExecutions = await db.select().from(executions).where(eq(executions.agentId, agentId))
    expect(queuedExecutions).toHaveLength(0)
  })

  it('returns continue when no questions and no unread messages', async () => {
    const result = await turnHooks.run(makeContext())
    expect(result).toEqual({ action: 'continue' })
  })
})
