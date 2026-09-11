import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { db } from '../../db'
import { agents, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { eq } from 'drizzle-orm'
import { validateScheduleReferences } from './reference-validation'

let squad: Squad
let manager: Agent
let worker: Agent

beforeEach(async () => {
  await AgentType.upsert({ id: 'manager', name: 'Manager', model: 'test:model', systemPrompt: 'test' })
  await AgentType.upsert({ id: 'engineer', name: 'Engineer', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: `refs-${crypto.randomUUID()}`, purpose: 'test' })
  manager = await Agent.create({ agentTypeId: 'manager', squadId: squad.id })
  worker = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id })
  await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squad.id))
})

afterEach(async () => {
  await db.delete(squads).where(eq(squads.id, squad.id))
})

describe('validateScheduleReferences', () => {
  it('resolves valid agent and squad scopes to their squad', async () => {
    await expect(
      validateScheduleReferences({
        scopeType: 'agent',
        scopeId: worker.id,
        action: { type: 'inbox_message', target: { type: 'agent', agentId: manager.id }, content: 'hello' },
      })
    ).resolves.toEqual({ squadId: squad.id })
    await expect(
      validateScheduleReferences({
        scopeType: 'squad',
        scopeId: squad.id,
        action: { type: 'inbox_message', target: { type: 'squad_manager' }, content: 'hello' },
      })
    ).resolves.toEqual({ squadId: squad.id })
  })

  it('rejects missing, terminated, and archived scopes with controlled permanent errors', async () => {
    await expect(
      validateScheduleReferences({
        scopeType: 'agent',
        scopeId: crypto.randomUUID(),
        action: { type: 'inbox_message', target: { type: 'agent', agentId: worker.id }, content: 'hello' },
      })
    ).rejects.toMatchObject({ code: 'scope_not_found', failureClass: 'permanent' })

    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, worker.id))
    await expect(
      validateScheduleReferences({
        scopeType: 'agent',
        scopeId: worker.id,
        action: { type: 'inbox_message', target: { type: 'agent', agentId: manager.id }, content: 'hello' },
      })
    ).rejects.toMatchObject({ code: 'scope_invalid' })

    await db.update(squads).set({ archivedAt: new Date(), status: 'archived' }).where(eq(squads.id, squad.id))
    await expect(
      validateScheduleReferences({
        scopeType: 'squad',
        scopeId: squad.id,
        action: { type: 'inbox_message', target: { type: 'agent', agentId: manager.id }, content: 'hello' },
      })
    ).rejects.toMatchObject({ code: 'scope_invalid' })
  })

  it('rejects missing and terminated inbox targets', async () => {
    const input = {
      scopeType: 'squad' as const,
      scopeId: squad.id,
      action: {
        type: 'inbox_message' as const,
        target: { type: 'agent' as const, agentId: crypto.randomUUID() as string },
        content: 'hello',
      },
    }
    await expect(validateScheduleReferences(input)).rejects.toMatchObject({ code: 'target_agent_not_found' })
    input.action.target.agentId = worker.id
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, worker.id))
    await expect(validateScheduleReferences(input)).rejects.toMatchObject({ code: 'target_agent_terminated' })
  })

  it('validates work-stream membership and agent types', async () => {
    const otherSquad = await Squad.create({ name: `other-${crypto.randomUUID()}`, purpose: 'test' })
    const outsider = await Agent.create({ agentTypeId: 'engineer', squadId: otherSquad.id })
    await expect(
      validateScheduleReferences({
        scopeType: 'squad',
        scopeId: squad.id,
        action: { type: 'create_work_stream', title: 'x', agentIds: [outsider.id] },
      })
    ).rejects.toMatchObject({ code: 'invalid_action_reference' })
    await expect(
      validateScheduleReferences({
        scopeType: 'squad',
        scopeId: squad.id,
        action: { type: 'spawn_agent', agentTypeId: 'missing-type', prompt: 'x' },
      })
    ).rejects.toMatchObject({ code: 'invalid_action_reference' })
    await db.delete(squads).where(eq(squads.id, otherSquad.id))
  })
})
