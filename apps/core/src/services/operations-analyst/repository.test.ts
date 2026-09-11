import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  operationsRecommendationEvidence,
  operationsRecommendationEvents,
  operationsRecommendations,
  squads,
} from '../../db/schema'
import { fingerprintFor } from './heuristics'
import { generatedEvidence } from './redaction'
import { listRecommendations, persistAnalysis, recommendationSquadId, updateRecommendationStatus } from './repository'
let squadId: string | undefined
afterEach(async () => {
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  squadId = undefined
})
describe('recommendation list scope predicates', () => {
  test('supports finite, unrestricted, and exclusion scopes without leaking denied squads', async () => {
    const created = await db
      .insert(squads)
      .values([0, 1, 2].map((index) => ({ name: `ops-scope-${index}-${crypto.randomUUID()}`, purpose: 'test' })))
      .returning()
    try {
      await db.insert(operationsRecommendations).values(
        created.map((squad, index) => ({
          squadId: squad.id,
          fingerprint: String(index).repeat(64),
          remediationType: 'add_sandbox_package',
          target: `tool-${index}`,
          proposedRemediation: { type: 'add_sandbox_package' as const, package: `tool-${index}` },
          title: `Tool ${index}`,
          summary: 'Unavailable',
          firstSeenAt: new Date(1_000 + index),
          lastSeenAt: new Date(1_000 + index),
          baseline: { sampleSize: 1, avgDurationMs: 1, avgTokens: 1, failedToolCalls: 0, estimatedAvoidableRetries: 0 },
          algorithmVersion: 'test',
          redactionVersion: 'test',
        }))
      )
      const list = (squadScope: { kind: 'some'; squadIds: string[] } | { kind: 'all'; excludedSquadIds: string[] }) =>
        listRecommendations({
          squadScope,
          limit: 10,
          cursorContext: { identitySubject: 'test', squadScope },
        })
      expect((await list({ kind: 'some', squadIds: [created[0].id] })).items.map((item) => item.squadId)).toEqual([
        created[0].id,
      ])
      const createdIds = created.map((squad) => squad.id)
      const unrestricted = await list({ kind: 'all', excludedSquadIds: [] })
      expect(unrestricted.items.filter((item) => createdIds.includes(item.squadId))).toHaveLength(3)
      const excluded = await list({ kind: 'all', excludedSquadIds: [created[1].id] })
      expect(excluded.items.map((item) => item.squadId)).not.toContain(created[1].id)
      expect(excluded.items.filter((item) => createdIds.includes(item.squadId))).toHaveLength(2)
    } finally {
      for (const squad of created) await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('recommendation lifecycle concurrency', () => {
  test('atomically couples one winning transition with one audit event', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-status-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [recommendation] = await db
      .insert(operationsRecommendations)
      .values({
        squadId: squad.id,
        fingerprint: 'c'.repeat(64),
        remediationType: 'add_sandbox_package',
        target: 'jq',
        proposedRemediation: { type: 'add_sandbox_package', package: 'jq' },
        title: 'Add jq',
        summary: 'jq was unavailable',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        baseline: { sampleSize: 1, avgDurationMs: 1, avgTokens: 1, failedToolCalls: 1, estimatedAvoidableRetries: 0 },
        algorithmVersion: 'ops-heuristics-v1',
        redactionVersion: 'ops-redaction-v1',
      })
      .returning()
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const beforeSelect = async () => {
      arrivals += 1
      if (arrivals === 2) release()
      await barrier
    }
    const results = await Promise.all([
      updateRecommendationStatus(recommendation.id, 'resolved', 'user:first', { beforeSelect }),
      updateRecommendationStatus(recommendation.id, 'dismissed', 'user:second', { beforeSelect }),
    ])
    expect(results.sort()).toEqual(['conflict', 'ok'])
    const [stored] = await db
      .select()
      .from(operationsRecommendations)
      .where(eq(operationsRecommendations.id, recommendation.id))
    const events = await db
      .select()
      .from(operationsRecommendationEvents)
      .where(eq(operationsRecommendationEvents.recommendationId, recommendation.id))
    expect(events).toHaveLength(1)
    expect(events[0].fromStatus).toBe('open')
    expect(events[0].toStatus).toBe(stored.status)
  })
})

describe('recommendation aggregate concurrency', () => {
  test('locks the recommendation while recomputing all committed evidence', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-aggregate-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const executionRows = await db
      .insert(executions)
      .values(
        [1, 2].map((n) => ({
          agentId: agent.id,
          status: 'completed' as const,
          startedAt: new Date(Date.now() - n * 1000),
          endedAt: new Date(),
        }))
      )
      .returning()
    const remediation = { type: 'review_sandbox_permission' as const, tool: 'bash' }
    const [recommendation] = await db
      .insert(operationsRecommendations)
      .values({
        squadId: squad.id,
        fingerprint: fingerprintFor(squad.id, remediation),
        remediationType: remediation.type,
        target: 'bash',
        proposedRemediation: remediation,
        title: 'Review bash permissions',
        summary: 'bash encountered permission failures',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        baseline: { sampleSize: 0, avgDurationMs: 0, avgTokens: 0, failedToolCalls: 0, estimatedAvoidableRetries: 0 },
        algorithmVersion: 'ops-heuristics-v1',
        redactionVersion: 'ops-redaction-v1',
      })
      .returning()
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const beforeAggregateLock = async (id: string) => {
      expect(id).toBe(recommendation.id)
      arrivals += 1
      if (arrivals === 2) release()
      await barrier
    }
    const analyze = (executionId: string, durationMs: number) =>
      persistAnalysis(
        {
          executionId,
          squadId: squad.id,
          agentId: agent.id,
          signals: [
            {
              type: 'permission_failure',
              remediation,
              normalizedTarget: 'bash',
              occurrenceCount: 1,
              failedToolCalls: 1,
              estimatedAvoidableRetries: 0,
              messageId: null,
              summary: generatedEvidence('bash encountered a sandbox permission failure'),
              observedAt: new Date(),
            },
          ],
          toolCallCount: 1,
          failedToolCallCount: 1,
          durationMs,
          tokenCount: durationMs,
        },
        { beforeAggregateLock }
      )
    await Promise.all([analyze(executionRows[0].id, 10), analyze(executionRows[1].id, 20)])
    const [stored] = await db
      .select()
      .from(operationsRecommendations)
      .where(eq(operationsRecommendations.id, recommendation.id))
    const evidence = await db
      .select()
      .from(operationsRecommendationEvidence)
      .where(eq(operationsRecommendationEvidence.recommendationId, recommendation.id))
    expect(evidence).toHaveLength(2)
    expect(stored.executionCount).toBe(2)
    expect(stored.recurrenceCount).toBe(2)
    expect(stored.baseline).toEqual({
      sampleSize: 2,
      avgDurationMs: 15,
      avgTokens: 15,
      failedToolCalls: 2,
      estimatedAvoidableRetries: 0,
    })
  })
})

describe('persisted signal-specific summaries', () => {
  test('preserves permission, repeated-failure, and workaround evidence templates', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-summary-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', endedAt: new Date() })
      .returning()
    const at = new Date()
    const signals = [
      {
        type: 'permission_failure' as const,
        remediation: { type: 'review_sandbox_permission' as const, tool: 'bash' },
        normalizedTarget: 'bash',
        occurrenceCount: 1,
        failedToolCalls: 1,
        estimatedAvoidableRetries: 0,
        messageId: null,
        summary: generatedEvidence('bash encountered a sandbox permission failure'),
        observedAt: at,
      },
      {
        type: 'repeated_tool_failure' as const,
        remediation: { type: 'improve_agent_tooling' as const, tool: 'read' },
        normalizedTarget: 'read',
        occurrenceCount: 2,
        failedToolCalls: 2,
        estimatedAvoidableRetries: 1,
        messageId: null,
        summary: generatedEvidence('read failed repeatedly in a completed execution'),
        observedAt: at,
      },
      {
        type: 'workaround_discussion' as const,
        remediation: { type: 'update_agent_guidance' as const, topic: 'environment-workarounds' },
        normalizedTarget: 'environment-workarounds',
        occurrenceCount: 1,
        failedToolCalls: 0,
        estimatedAvoidableRetries: 0,
        messageId: null,
        summary: generatedEvidence('A consumed inter-agent message discussed an environment workaround'),
        observedAt: at,
      },
    ]
    await persistAnalysis({
      executionId: execution.id,
      squadId: squad.id,
      agentId: agent.id,
      signals,
      toolCallCount: 3,
      failedToolCallCount: 3,
      durationMs: 10,
      tokenCount: 20,
    })
    const recommendations = await db
      .select()
      .from(operationsRecommendations)
      .where(eq(operationsRecommendations.squadId, squad.id))
    const evidence = await db.select().from(operationsRecommendationEvidence)
    const recommendationIds = new Set(recommendations.map((row) => row.id))
    const summaries = evidence.filter((row) => recommendationIds.has(row.recommendationId)).map((row) => row.summary)
    expect(summaries).toContain('bash encountered a sandbox permission failure')
    expect(summaries).toContain('read failed repeatedly in a completed execution')
    expect(summaries).toContain('A consumed inter-agent message discussed an environment workaround')
    expect(recommendations.map((row) => row.summary)).toEqual(
      expect.arrayContaining([
        'bash encountered sandbox permission failures in completed executions.',
        'read failed repeatedly in completed executions.',
        'Completed executions included inter-agent environment workaround discussions.',
      ])
    )
  })
})

describe('recommendation squad lookup failures', () => {
  test('propagates storage failures instead of falling back to unscoped authorization', async () => {
    const failure = new Error('database unavailable')
    await expect(
      recommendationSquadId(crypto.randomUUID(), {
        findSquadId: async () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
  })
})
