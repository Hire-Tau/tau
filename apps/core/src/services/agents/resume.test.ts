import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import {
  isErrorHalted,
  listErrorHaltedAgents,
  resumeHaltedAgent,
  resumeHaltedAgentAuthoritatively,
  setResumeHaltedBeforeAuthoritativeLockHookForTests,
} from './resume'
import { listPendingActions } from './actions'

function haltQuestion(id: string) {
  return {
    questions: [
      {
        id,
        type: 'select' as const,
        question: 'All providers exhausted. Try again later.',
        options: [{ value: 'Continue' }],
      },
    ],
  }
}

describe('error-halt resume + Action Center', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  let createdAgentIds: string[]

  beforeEach(async () => {
    prefix = `rh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${prefix}-type`
    createdAgentIds = []
    await AgentType.create({
      id: agentTypeId,
      name: 'RH Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'x',
    })
    squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'resume test' })
  })

  afterEach(async () => {
    setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
    if (createdAgentIds.length) {
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    }
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  async function makeHalted(questionId: string): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    await agent.update({
      status: 'waiting-input',
      questionData: haltQuestion(questionId),
      context: { squadId: squad.id },
    })
    return (await Agent.find(agent.id))!
  }

  it('classifies exhaustion halts and resumes them, but leaves genuine questions alone', async () => {
    const halted = await makeHalted('all_providers_exhausted')
    const asking = await makeHalted('clarify_requirements')

    expect(isErrorHalted(halted)).toBe(true)
    expect(isErrorHalted(asking)).toBe(false)

    const haltedList = await listErrorHaltedAgents()
    expect(haltedList.map((a) => a.id)).toContain(halted.id)
    expect(haltedList.map((a) => a.id)).not.toContain(asking.id)

    // resume clears waiting-input and queues a fresh execution
    expect(await resumeHaltedAgent(halted)).toBe(true)
    const reloaded = (await Agent.find(halted.id))!
    expect(reloaded.status).not.toBe('waiting-input')
    const execs = await db.select().from(executions).where(eq(executions.agentId, halted.id))
    expect(execs.some((e) => e.status === 'queued')).toBe(true)

    // resuming a genuine ask_human halt is a no-op
    expect(await resumeHaltedAgent(asking)).toBe(false)
  })

  it('serializes duplicate replay and fences concurrent termination', async () => {
    const replayed = await makeHalted('rate_limit')
    const outcomes = await Promise.all([
      resumeHaltedAgentAuthoritatively(replayed.id),
      resumeHaltedAgentAuthoritatively(replayed.id),
    ])
    expect(outcomes.sort()).toEqual(['resumed', 'stale'])
    expect(await db.select().from(executions).where(eq(executions.agentId, replayed.id))).toHaveLength(1)

    const terminated = await makeHalted('rate_limit')
    setResumeHaltedBeforeAuthoritativeLockHookForTests(async (agentId) => {
      setResumeHaltedBeforeAuthoritativeLockHookForTests(undefined)
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agentId))
    })
    expect(await resumeHaltedAgentAuthoritatively(terminated.id)).toBe('stale')
    expect(await db.select().from(executions).where(eq(executions.agentId, terminated.id))).toHaveLength(0)
  })

  it('surfaces exhaustion halts as agent-error (not squad-question) in the Action Center', async () => {
    const halted = await makeHalted('rate_limit')
    const asking = await makeHalted('clarify_requirements')

    const actions = await listPendingActions()
    const errorIds = actions.filter((a) => a.type === 'agent-error').map((a) => (a.data as { agentId: string }).agentId)
    const questionIds = actions
      .filter((a) => a.type === 'squad-question')
      .map((a) => (a.data as { agentId: string }).agentId)

    expect(errorIds).toContain(halted.id)
    expect(errorIds).not.toContain(asking.id)
    expect(questionIds).not.toContain(halted.id)
    expect(questionIds).toContain(asking.id)
  })
})
