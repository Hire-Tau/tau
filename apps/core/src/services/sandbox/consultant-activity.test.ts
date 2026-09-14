import { expect, test } from 'bun:test'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { db, agents, executions, squads } from '../../db'
import { inArray } from 'drizzle-orm'
import { sandboxActivity } from '../machines/sandbox-activity'
import { consultantSandboxId } from './consultant-sandbox'
import { inspectAgentSigningIdentity } from '../amtp/agent-signing-identity'

test('consultant runtime activity counts every chat and its subagents but excludes other squads', async () => {
  const squad = await Squad.create({ purpose: 'test', name: `Consultant activity ${crypto.randomUUID()}` })
  const other = await Squad.create({ purpose: 'test', name: `Other consultant ${crypto.randomUUID()}` })
  const ids: string[] = []
  try {
    const a = await Agent.create({ squadId: squad.id, agentTypeId: 'consultant' })
    ids.push(a.id)
    const b = await Agent.create({ squadId: squad.id, agentTypeId: 'consultant' })
    ids.push(b.id)
    const child = await Agent.create({ squadId: squad.id, agentTypeId: 'subagent', parentAgentId: a.id })
    ids.push(child.id)
    const neighbor = await Agent.create({ squadId: other.id, agentTypeId: 'consultant' })
    ids.push(neighbor.id)
    expect(await child.getSandboxId()).toBe(consultantSandboxId(squad.id))
    expect(await inspectAgentSigningIdentity(a)).toMatchObject({
      status: 'unsupported',
      reason: 'shared_consultant_custody',
    })
    for (const agent of [a, b, child, neighbor])
      await db.insert(executions).values({ agentId: agent.id, status: 'queued' })
    expect(await sandboxActivity(consultantSandboxId(squad.id))).toEqual({ active: true, activeExecutionCount: 3 })
    expect(await sandboxActivity(consultantSandboxId(other.id))).toEqual({ active: true, activeExecutionCount: 1 })
  } finally {
    if (ids.length) {
      await db.delete(executions).where(inArray(executions.agentId, ids))
      await db.delete(agents).where(inArray(agents.id, ids))
    }
    await db.delete(squads).where(inArray(squads.id, [squad.id, other.id]))
  }
})
