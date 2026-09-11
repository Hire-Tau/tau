import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, inbox } from '../db/schema'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { InboxMessage, formatInboxMessageSender } from './InboxMessage'

describe('InboxMessage.send remote sender', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let agentId: string

  beforeEach(async () => {
    testPrefix = `inbox-remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    const agent = await Agent.create({
      agentTypeId: testAgentTypeId,
      metadata: { name: 'LocalRecipient' },
    })
    agentId = agent.id
  })

  afterEach(async () => {
    // Clean up inbox rows for all agents created in this test suite
    const allAgents = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const a of allAgents) {
      await db.delete(inbox).where(eq(inbox.recipientId, a.id))
    }
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  const fromAddress = 'amtp://peer-instance-1/alice'

  const remoteMetadata = (overrides: Record<string, unknown> = {}) => ({
    peerInstanceId: 'peer-instance-1',
    fromAddress,
    fromHandle: 'alice',
    envelopeId: '11111111-1111-4111-8111-111111111111',
    agentSigVerified: false as const,
    ...overrides,
  })

  it('persists metadata.remote and a caller-supplied metadata.sender, and formats the name', async () => {
    const message = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'remote',
      senderId: fromAddress,
      subject: 'hello from afar',
      content: 'first contact',
      deliveryMode: 'follow-up',
      metadata: {
        remote: remoteMetadata(),
        sender: { name: 'alice' },
      },
    })

    expect(message.senderType).toBe('remote')
    expect(message.senderId).toBe(fromAddress)

    const remote = message.metadata.remote as Record<string, unknown>
    expect(remote).toBeDefined()
    expect(remote.peerInstanceId).toBe('peer-instance-1')
    expect(remote.fromHandle).toBe('alice')
    expect(remote.envelopeId).toBe('11111111-1111-4111-8111-111111111111')
    expect(remote.agentSigVerified).toBe(false)

    const sender = message.metadata.sender as Record<string, unknown>
    expect(sender.name).toBe('alice')

    const formatted = formatInboxMessageSender(message)
    expect(formatted).toContain('alice')
    expect(formatted).not.toBe('remote')
  })

  it('derives metadata.sender.name from metadata.remote.fromHandle when no sender supplied', async () => {
    const message = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'remote',
      senderId: 'amtp://peer-instance-1/bob',
      content: 'no sender block supplied',
      deliveryMode: 'follow-up',
      metadata: {
        remote: remoteMetadata({ fromHandle: 'bob', fromAddress: 'amtp://peer-instance-1/bob' }),
      },
    })

    const sender = message.metadata.sender as Record<string, unknown>
    expect(sender.name).toBe('bob')
    expect(formatInboxMessageSender(message)).toContain('bob')
  })

  it('keeps the CASE-on-UUID join safe when re-reading a non-UUID remote senderId', async () => {
    const sent = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'remote',
      senderId: fromAddress,
      content: 'round trip',
      deliveryMode: 'follow-up',
      metadata: {
        remote: remoteMetadata(),
        sender: { name: 'alice' },
      },
    })

    // InboxMessage.find leftJoins senderAgents via
    // `CASE WHEN senderType = 'agent' THEN senderId::uuid END = sender_agents.id`.
    // A non-UUID `amtp://` senderId must NOT be cast (no global query throw).
    const reloaded = await InboxMessage.find(sent.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded!.senderType).toBe('remote')
    expect(reloaded!.senderId).toBe(fromAddress)
    expect(reloaded!.senderAgent).toBeNull()
    const sender = reloaded!.metadata.sender as Record<string, unknown>
    expect(sender.name).toBe('alice')
  })

  it('delivers a remote message to a subagent recipient (skips the parent-only guard)', async () => {
    // Create a parent agent and a subagent. The subagent has a parentAgentId set,
    // which would normally trigger the guard:
    //   "Only a subagent parent may message that subagent"
    // For senderType='remote', that guard must be skipped — federation auth is
    // handled by allow-rules (a later task), not the parent relationship.
    const parentAgent = await Agent.create({
      agentTypeId: testAgentTypeId,
      metadata: { name: 'ParentAgent' },
    })
    const subAgent = await Agent.create({
      agentTypeId: testAgentTypeId,
      parentAgentId: parentAgent.id,
      metadata: { name: 'SubAgent' },
    })

    const message = await InboxMessage.send({
      recipientType: 'agent',
      recipientId: subAgent.id,
      senderType: 'remote',
      senderId: fromAddress,
      content: 'federated message to subagent',
      deliveryMode: 'follow-up',
      metadata: {
        remote: remoteMetadata({ fromHandle: 'alice' }),
        sender: { name: 'alice' },
      },
    })

    // Row is stored (no throw)
    expect(message.senderType).toBe('remote')
    expect(message.senderId).toBe(fromAddress)
    expect(message.recipientId).toBe(subAgent.id)

    // metadata.sender.name is persisted
    const sender = message.metadata.sender as Record<string, unknown>
    expect(sender.name).toBe('alice')
    expect(formatInboxMessageSender(message)).toContain('alice')
  })
})
