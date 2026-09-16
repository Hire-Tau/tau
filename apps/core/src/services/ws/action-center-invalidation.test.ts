import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestionRecipients, agents, agentTypes, executions, squads, users } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils'
import { createAgentQuestion } from '../agents/questions'
import { subscribeToSquad, unsubscribeFromSquad } from '../squad/subscriptions'
import { setupEventBridge } from './bridge'
import { WebSocketManager } from './manager'

function openSocket() {
  return { readyState: WebSocket.OPEN, send: mock((_data: string) => 0) } as any
}

async function waitForCallCount(ws: ReturnType<typeof openSocket>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ws.send.mock.calls.length >= count) return
    await Bun.sleep(10)
  }
}

describe('Action Center canonical WebSocket invalidation', () => {
  let prefix: string
  let agentTypeId: string
  let agentId: string
  let squadId: string
  let userIds: string[]

  beforeEach(async () => {
    prefix = `ws-action-${crypto.randomUUID().slice(0, 8)}`
    agentTypeId = `${prefix}-type`
    userIds = []
    eventEmitter.removeAllListeners()
    await AgentType.create({
      id: agentTypeId,
      name: `${prefix} type`,
      model: 'test:model',
      systemPrompt: 'test',
    })
  })

  afterEach(async () => {
    eventEmitter.removeAllListeners()
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId))
    if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    if (userIds.length) await cleanupTestRbac(prefix)
  })

  test('delivers every lifecycle hint only to the current canonical audience', async () => {
    const [owner, direct, watcher, unrelated] = await Promise.all(
      ['owner', 'direct', 'watcher', 'unrelated'].map(async (name) => {
        const user = await createTestUser({ prefix, displayName: `${prefix}-${name}` })
        userIds.push(user.id)
        return user
      })
    )
    const role = await createTestRole({ prefix, permissions: ['actions:read'] })
    const squad = await Squad.create({ name: `${prefix} squad`, purpose: 'Action Center WebSocket test' })
    squadId = squad.id
    await assignRole({ userId: watcher.id, roleId: role.id, scope: 'squad', squadId })
    await subscribeToSquad(squadId, watcher.id)
    const agent = await Agent.create({ agentTypeId, squadId, ownerUserId: owner.id })
    agentId = agent.id
    const [execution] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
    const question = await createAgentQuestion(
      { agentId, executionId: execution.id },
      { questions: [{ id: 'q1', type: 'text', question: `${prefix} sensitive question` }] }
    )
    await db.insert(agentQuestionRecipients).values({
      questionId: question.id,
      userId: direct.id,
      reason: 'execution-participant',
    })

    const manager = new WebSocketManager()
    const sockets = new Map(
      [owner, direct, watcher, unrelated].map((user) => {
        const ws = openSocket()
        return [user.id, { ws, client: manager.addClient(ws, { type: 'user', userId: user.id }) }] as const
      })
    )
    for (const { client, ws } of sockets.values()) {
      await manager.subscribe(client, 'actions')
      ws.send.mockClear()
    }
    setupEventBridge(manager)

    for (const event of [
      'agent-question.created',
      'agent-question.answered',
      'agent-question.delivery-failed',
      'agent-question.delivery-retrying',
      'agent-question.dismissed',
    ] as const) {
      eventEmitter.emit(event, { questionId: question.id, agentId, squadId })
    }
    await waitForCallCount(sockets.get(direct.id)!.ws, 5)

    for (const user of [direct, watcher]) {
      const calls = sockets.get(user.id)!.ws.send.mock.calls
      expect(calls).toHaveLength(5)
      for (const [serialized] of calls) {
        expect(JSON.parse(serialized as string)).toEqual({
          type: 'event',
          topic: 'actions',
          event: 'actions.invalidated',
          data: {},
        })
        expect(serialized as string).not.toContain(prefix)
      }
    }
    // The squad-bound agent's stored owner and an unrelated user get no attention hints:
    // ownership metadata is not an attention entitlement, and reading nothing elsewhere.
    expect(sockets.get(owner.id)!.ws.send).not.toHaveBeenCalled()
    expect(sockets.get(unrelated.id)!.ws.send).not.toHaveBeenCalled()

    // The hint audience is permission-shaped, not subscription-shaped: dropping the subscription
    // does not stop a reader's Needs you list from being invalidated (the frame carries nothing).
    await unsubscribeFromSquad(squadId, watcher.id)
    sockets.get(watcher.id)!.ws.send.mockClear()
    eventEmitter.emit('agent-question.delivery-retrying', { questionId: question.id, agentId, squadId })
    await waitForCallCount(sockets.get(watcher.id)!.ws, 1)
    expect(sockets.get(watcher.id)!.ws.send).toHaveBeenCalled()

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, direct.id))
    sockets.get(direct.id)!.ws.send.mockClear()
    eventEmitter.emit('agent-question.dismissed', { questionId: question.id, agentId, squadId })
    await Bun.sleep(150)
    expect(sockets.get(direct.id)!.ws.send).not.toHaveBeenCalled()
  })
})
