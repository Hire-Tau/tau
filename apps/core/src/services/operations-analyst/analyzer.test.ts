import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  messages,
  operationsExecutionAnalyses,
  operationsRecommendationEvidence,
  operationsRecommendations,
  squads,
} from '../../db/schema'
import { analyzeExecution } from './analyzer'

const createdSquads: string[] = []
afterAll(async () => {
  for (const id of createdSquads) await db.delete(squads).where(eq(squads.id, id))
})
describe('analyzeExecution', () => {
  test('persists redacted, idempotent recommendation evidence for a completed execution', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const startedAt = new Date(Date.now() - 1000)
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        startedAt,
        endedAt: new Date(),
        usage: { stats: { tokens: { total: 42 } } },
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: '',
      metadata: {
        executionId: execution.id,
        streamGroupId: `${execution.id}:main`,
        content: [
          {
            type: 'tool_use',
            toolCall: {
              toolCallId: 't1',
              toolName: 'bash',
              args: JSON.stringify({ command: 'devbox add jq' }),
              result: 'bash: jq: command not found SENTINEL',
              isError: true,
            },
          },
        ],
      },
    })
    expect(await analyzeExecution(execution.id, { getKnownSecrets: async () => ['SENTINEL'] })).toBe('analyzed')
    expect(await analyzeExecution(execution.id, { getKnownSecrets: async () => ['SENTINEL'] })).toBe('already-analyzed')
    const analyses = await db
      .select()
      .from(operationsExecutionAnalyses)
      .where(eq(operationsExecutionAnalyses.executionId, execution.id))
    const recs = await db
      .select()
      .from(operationsRecommendations)
      .where(eq(operationsRecommendations.squadId, squad.id))
    const evidence = await db
      .select()
      .from(operationsRecommendationEvidence)
      .where(eq(operationsRecommendationEvidence.executionId, execution.id))
    expect(analyses).toHaveLength(1)
    expect(recs).toHaveLength(1)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].summary).not.toContain('SENTINEL')
    expect(recs[0].baseline).toEqual(expect.objectContaining({ sampleSize: 1, avgTokens: 42 }))
    const [agentAfter] = await db.select().from(agents).where(eq(agents.id, agent.id))
    const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(agentAfter).toEqual(agent)
    expect(executionAfter).toEqual(execution)
  })
})
