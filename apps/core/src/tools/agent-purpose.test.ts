import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { db } from '../db'
import { squads } from '../db/schema'
import { createSetAgentPurposeTool } from './agent-purpose'

const testAgentTypeId = 'agent-purpose-test'
const managerAgentTypeId = 'manager'
const consultantAgentTypeId = 'consultant'
const systemManagerAgentTypeId = 'system-manager'
const testSquadId = '00000000-0000-4000-8000-000000000001'

describe('createSetAgentPurposeTool', () => {
  // Seed the parent squad the test agents reference. The
  // agents_squad_id_squads_id_fk foreign key was restored in the test DB (#1048)
  // to match production schema, so an agent can no longer be inserted against a
  // squad row that does not exist. No other test file inserts this squad id.
  beforeAll(async () => {
    await db.insert(squads).values({ id: testSquadId, name: 'Agent Purpose Test Squad', purpose: 'test' })
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  it('updates only the invoking squad worker purpose', async () => {
    await AgentType.upsert({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Agent Purpose Test',
      systemPrompt: 'You are a test agent.',
    })

    const invokingAgent = await Agent.create({ agentTypeId: testAgentTypeId, name: 'Invoker', squadId: testSquadId })
    const otherAgent = await Agent.create({ agentTypeId: testAgentTypeId, name: 'Other', squadId: testSquadId })

    try {
      const tool = createSetAgentPurposeTool({ agentId: invokingAgent.id })
      await tool.execute('call-1', { purpose: '  Dynamic purpose setter  ' }, undefined, undefined, {} as any)

      await invokingAgent.reload()
      await otherAgent.reload()

      expect(invokingAgent.metadata?.purpose).toBe('Dynamic purpose setter')
      expect(invokingAgent.metadata?.name).toBe('Invoker')
      expect(otherAgent.metadata?.purpose).toBeUndefined()
      expect(otherAgent.metadata?.name).toBe('Other')
    } finally {
      await invokingAgent.update({ squadId: null } as any)
      await otherAgent.update({ squadId: null } as any)
      await invokingAgent.delete()
      await otherAgent.delete()
    }
  })

  it('rejects squad managers', async () => {
    await AgentType.upsert({
      id: managerAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Manager',
      systemPrompt: 'You are a manager.',
    })
    const manager = await Agent.create({ agentTypeId: managerAgentTypeId, name: 'Pearl', squadId: testSquadId })

    try {
      const tool = createSetAgentPurposeTool({ agentId: manager.id })
      const result = await tool.execute('call-1', { purpose: '  Coordinate work  ' }, undefined, undefined, {} as any)

      await manager.reload()
      expect((result.details as { success: boolean }).success).toBe(false)
      expect(result.content[0]?.type).toBe('text')
      expect((result.content[0] as { type: 'text'; text: string })?.text).toContain('not available for squad managers')
      expect(manager.metadata?.purpose).toBeUndefined()
    } finally {
      await manager.update({ squadId: null } as any)
      await manager.delete()
    }
  })

  it('allows consultants and system managers', async () => {
    await AgentType.upsert({
      id: consultantAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Consultant',
      systemPrompt: 'You are a consultant.',
    })
    await AgentType.upsert({
      id: systemManagerAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'System Manager',
      systemPrompt: 'You are a system manager.',
    })
    const consultant = await Agent.create({ agentTypeId: consultantAgentTypeId, squadId: testSquadId, name: 'Cora' })
    const systemManager = await Agent.create({ agentTypeId: systemManagerAgentTypeId, name: 'Nova' })

    try {
      await createSetAgentPurposeTool({ agentId: consultant.id }).execute(
        'call-1',
        { purpose: 'Route requests' },
        undefined,
        undefined,
        {} as any
      )
      await createSetAgentPurposeTool({ agentId: systemManager.id }).execute(
        'call-2',
        { purpose: 'Coordinate squads' },
        undefined,
        undefined,
        {} as any
      )

      await consultant.reload()
      await systemManager.reload()
      expect(consultant.metadata?.purpose).toBe('Route requests')
      expect(systemManager.metadata?.purpose).toBe('Coordinate squads')
    } finally {
      await consultant.update({ squadId: null } as any)
      await consultant.delete()
      await systemManager.delete()
    }
  })
})
