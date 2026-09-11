import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PendingAction } from '@tau/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { canReceiveAgentQuestionAttention, evaluatePendingAction } from './pending-action-policy'

const prefix = `pending-action-policy-${crypto.randomUUID()}`
let staleSquad: Squad
let currentSquad: Squad
let target: Agent
let responder: TestUser

beforeAll(async () => {
  await AgentType.create({
    id: `${prefix}-type`,
    name: 'Pending action policy',
    model: 'test:model',
    systemPrompt: 'test',
  })
  staleSquad = await Squad.create({ name: `${prefix}-stale`, purpose: 'stale serialized squad' })
  currentSquad = await Squad.create({ name: `${prefix}-current`, purpose: 'authoritative agent squad' })
  target = await Agent.create({
    agentTypeId: `${prefix}-type`,
    squadId: currentSquad.id,
    context: { squadId: staleSquad.id },
  })
  responder = await createTestUser({ prefix: `${prefix}-responder` })
  const role = await createTestRole({
    prefix: `${prefix}-role`,
    permissions: ['actions:read', 'agents:run'],
  })
  await assignRole({ userId: responder.id, roleId: role.id, scope: 'squad', squadId: currentSquad.id })
})

afterAll(async () => {
  await db.delete(agents).where(eq(agents.id, target.id))
  await db.delete(squads).where(eq(squads.id, staleSquad.id))
  await db.delete(squads).where(eq(squads.id, currentSquad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

describe('pending action response capability', () => {
  test('does not turn historical question visibility into response authority', async () => {
    const recipient = { type: 'user' as const, userId: '00000000-0000-0000-0000-000000000001' }

    // Read-only attention visibility never implies the ability to respond; response
    // authority lives in question-authorization (see question-authorization.test.ts).
    expect(
      await canReceiveAgentQuestionAttention(
        recipient,
        { id: '00000000-0000-0000-0000-000000000000', ownerUserId: null, squadId: target.squadId },
        {
          watchedSquadIds: new Set<string>(),
          watchedWorkStreamIds: new Set<string>(),
        }
      )
    ).toBe(false)
  })

  test('uses the live nonterminated agent squad for legacy squad questions', async () => {
    const action: PendingAction = {
      id: `squad-question:${target.id}`,
      type: 'squad-question',
      priority: 1,
      createdAt: new Date().toISOString(),
      canRespond: false,
      squadId: staleSquad.id,
      squadName: staleSquad.name,
      data: {
        agentId: target.id,
        agentName: null,
        agentTypeId: target.agentTypeId,
        squadId: staleSquad.id,
        squadName: staleSquad.name,
        questionData: { questions: [{ id: 'input', type: 'text', question: 'Input?' }] },
      },
    }
    const identity = { type: 'user' as const, userId: responder.id }
    const context = {
      watchedSquadIds: new Set([currentSquad.id]),
      watchedWorkStreamIds: new Set<string>(),
    }

    expect(await evaluatePendingAction(identity, action, context)).toEqual({ visible: true, canRespond: true })

    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, target.id))
    expect(await evaluatePendingAction(identity, action, context)).toEqual({ visible: false, canRespond: false })
  })
})
