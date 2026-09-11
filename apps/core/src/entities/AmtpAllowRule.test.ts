import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { like, inArray } from 'drizzle-orm'
import { db, amtpAllowRules, agents, agentTypes } from '../db'
import { Agent } from './Agent'
import { AgentType } from './AgentType'
import { AmtpAllowRule, isSenderAllowed } from './AmtpAllowRule'

describe('AmtpAllowRule', () => {
  let testAgentTypeId: string
  let agentId: string
  let otherAgentId: string

  beforeEach(async () => {
    testAgentTypeId = `far-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    agentId = (await Agent.create({ agentTypeId: testAgentTypeId })).id
    otherAgentId = (await Agent.create({ agentTypeId: testAgentTypeId })).id
  })

  afterEach(async () => {
    await db.delete(amtpAllowRules).where(inArray(amtpAllowRules.targetAgentId, [agentId, otherAgentId]))
    await db.delete(agents).where(inArray(agents.id, [agentId, otherAgentId]))
    await db.delete(agentTypes).where(like(agentTypes.id, 'far-%'))
  })

  test('create + listForAgent + delete', async () => {
    const rule = await AmtpAllowRule.create({
      targetAgentId: agentId,
      peerInstanceId: 'peer-a',
      principalKind: 'any',
    })
    expect(rule.principalKind).toBe('any')
    expect(rule.principalValue).toBeNull()
    const list = await AmtpAllowRule.listForAgent(agentId)
    expect(list.map((r) => r.id)).toEqual([rule.id])
    await AmtpAllowRule.delete(rule.id)
    expect(await AmtpAllowRule.listForAgent(agentId)).toHaveLength(0)
  })

  test('default-deny: rejects when no rule exists', async () => {
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(
      false
    )
  })

  test("kind 'any' permits any sender from that peer", async () => {
    await AmtpAllowRule.create({ targetAgentId: agentId, peerInstanceId: 'peer-a', principalKind: 'any' })
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(
      true
    )
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'bob' })).toBe(true)
  })

  test("kind 'handle' permits only the matching handle", async () => {
    await AmtpAllowRule.create({
      targetAgentId: agentId,
      peerInstanceId: 'peer-a',
      principalKind: 'handle',
      principalValue: 'alice',
    })
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(
      true
    )
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'bob' })).toBe(false)
  })

  test('a rule for a different peer or agent does not match', async () => {
    await AmtpAllowRule.create({ targetAgentId: agentId, peerInstanceId: 'peer-a', principalKind: 'any' })
    // different peer, same agent
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-b', senderHandle: 'alice' })).toBe(
      false
    )
    // same peer, different agent
    expect(
      await isSenderAllowed({ targetAgentId: otherAgentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })
    ).toBe(false)
  })

  test("create throws when 'handle' rule is missing principalValue", async () => {
    await expect(
      AmtpAllowRule.create({
        targetAgentId: agentId,
        peerInstanceId: 'peer-a',
        principalKind: 'handle',
        // no principalValue
      })
    ).rejects.toThrow("'handle' allow-rule requires a non-empty principalValue")
  })

  test('unknown principalKind row defaults to deny', async () => {
    // Bypass create() to insert a row with an unknown principalKind
    await db.insert(amtpAllowRules).values({
      targetAgentId: agentId,
      peerInstanceId: 'peer-a',
      principalKind: 'unknown',
      principalValue: null,
    })
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(
      false
    )
  })

  test("'handle' rule with null principalValue denies all senders", async () => {
    // Bypass create() to insert a 'handle' row with null principalValue
    await db.insert(amtpAllowRules).values({
      targetAgentId: agentId,
      peerInstanceId: 'peer-a',
      principalKind: 'handle',
      principalValue: null,
    })
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'alice' })).toBe(
      false
    )
    expect(await isSenderAllowed({ targetAgentId: agentId, peerInstanceId: 'peer-a', senderHandle: 'bob' })).toBe(false)
  })
})
