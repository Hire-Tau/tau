import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../../db'
import { agents, agentTypes, executions, messages, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import { SquadWorkerRunner } from '../../entities/agent-runners/squad-worker-runner'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { concurrencyLimiter } from './concurrency-limiter-instance'
import { getActiveSessionCount, removeSession } from './session-state'
import { MockAgentSession } from './test-helpers'
import { tryPickupExecutionForTest } from '../../worker'

const QUEUED_PICKUP_LATENCY_ASSERTION_MS = 500
const EXECUTION_STARTED_EVENT_TIMEOUT_MS = 2_000
const PROMPT_DISPATCH_TIMEOUT_MS = 2_000
const EXECUTION_COMPLETION_TIMEOUT_MS = 5_000

// This exercises the real worker pickup path plus runner completion DB writes.
// Keep the queued→running latency assertion tight, but give Bun enough room for
// the integration-style cleanup/completion waits under loaded CI hosts.
const SQUAD_START_LATENCY_TEST_TIMEOUT_MS = 15_000

/**
 * Poll-based wait with a wall-clock deadline. Unlike a fixed attempt count,
 * the total wait time is bounded by timeoutMs regardless of how slow each
 * check() invocation is (e.g. DB queries under CI load).
 *
 * The default 5s timeout matches the convention used in integration.test.ts
 * and gives ample headroom for the multi-step async completion chain
 * (message persistence → agent settled → turn hooks → execution.complete)
 * which involves several sequential DB round-trips.
 */
async function waitFor(
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50, description = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${description} (after ${timeoutMs}ms)`)
}

function observeExecutionStarted(executionId: string): { startedAt: Promise<number>; stop: () => void } {
  let stop = () => {}
  const startedAt = new Promise<number>((resolve) => {
    stop = eventEmitter.on('execution.started', (payload: { executionId: string; agentId: string }) => {
      if (payload.executionId !== executionId) return
      stop()
      resolve(performance.now())
    })
  })
  return { startedAt, stop }
}

async function waitForObservedExecutionStarted(
  observation: { startedAt: Promise<number>; stop: () => void },
  options: { agentId: string; executionId: string; timeoutMs?: number }
): Promise<number> {
  const { agentId, executionId, timeoutMs = EXECUTION_STARTED_EVENT_TIMEOUT_MS } = options
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      observation.startedAt,
      new Promise<number>((_, reject) => {
        timeout = setTimeout(() => {
          describePickupState(executionId)
            .catch((error) => `diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`)
            .then((diagnostics) => {
              reject(
                new Error(
                  `Timed out waiting for execution.started for agent ${agentId} (after ${timeoutMs}ms): ${diagnostics}`
                )
              )
            })
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    observation.stop()
  }
}

async function describePickupState(executionId: string): Promise<string> {
  const [execution, queued] = await Promise.all([Execution.find(executionId), Execution.list({ status: 'queued' })])
  const queuedPosition = queued.findIndex((exec) => exec.id === executionId)
  return JSON.stringify({
    status: execution?.status ?? 'missing',
    activeSessions: getActiveSessionCount(),
    queuedCount: queued.length,
    queuedPosition: queuedPosition === -1 ? null : queuedPosition + 1,
    concurrency: concurrencyLimiter.snapshot(),
  })
}

describe('squad execution start latency', () => {
  const createdAgentIds: string[] = []
  const createdSquadIds: string[] = []
  const createdAgentTypeIds: string[] = []
  let restoreCreateSession: (() => void) | undefined

  beforeEach(() => {
    concurrencyLimiter.reset()
  })

  afterEach(async () => {
    concurrencyLimiter.reset()
    restoreCreateSession?.()
    restoreCreateSession = undefined
    for (const agentId of createdAgentIds.splice(0)) {
      removeSession(agentId)
      await db
        .delete(messages)
        .where(eq(messages.agentId, agentId))
        .catch(() => {})
      await db
        .delete(executions)
        .where(eq(executions.agentId, agentId))
        .catch(() => {})
      await db
        .delete(agents)
        .where(eq(agents.id, agentId))
        .catch(() => {})
    }
    for (const squadId of createdSquadIds.splice(0)) {
      await db
        .delete(squads)
        .where(eq(squads.id, squadId))
        .catch(() => {})
    }
    for (const agentTypeId of createdAgentTypeIds.splice(0)) {
      await db
        .delete(agentTypes)
        .where(eq(agentTypes.id, agentTypeId))
        .catch(() => {})
    }
  })

  test(
    'queued squad executions leave queued promptly through the backend pickup path',
    async () => {
      const agentTypeId = `latency-worker-${randomUUID()}`
      createdAgentTypeIds.push(agentTypeId)
      await AgentType.create({
        id: agentTypeId,
        name: 'Latency Worker',
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'You are a latency test worker.',
      })

      const [squadRow] = await db
        .insert(squads)
        .values({ name: 'Latency Squad', purpose: 'Exercise squad execution pickup path' })
        .returning()
      createdSquadIds.push(squadRow.id)

      const agent = await Agent.create({ agentTypeId, squadId: squadRow.id })
      createdAgentIds.push(agent.id)
      const mockSession = new MockAgentSession()
      const originalCreateSession = (SquadWorkerRunner.prototype as any).createSession
      ;(SquadWorkerRunner.prototype as any).createSession = async function (this: any, scope: any) {
        return this.createPiSession(scope, async () => mockSession)
      }
      restoreCreateSession = () => {
        ;(SquadWorkerRunner.prototype as any).createSession = originalCreateSession
      }

      const execution = await agent.queueExecution({ message: 'start quickly' })
      const started = observeExecutionStarted(execution.id)
      const queuedAt = performance.now()
      // Exercise the same backend pickup checks as the worker, but target this
      // execution so unrelated queued rows in a polluted CI database cannot
      // consume the test's latency window before this execution is considered.
      const pickedUp = await tryPickupExecutionForTest(execution.id)
      if (!pickedUp) {
        started.stop()
        throw new Error(
          `Expected targeted pickup to accept queued execution: ${await describePickupState(execution.id)}`
        )
      }

      const elapsedMs =
        (await waitForObservedExecutionStarted(started, { agentId: agent.id, executionId: execution.id })) - queuedAt
      expect(elapsedMs).toBeLessThanOrEqual(QUEUED_PICKUP_LATENCY_ASSERTION_MS)

      const reloaded = await Execution.mustFind(execution.id)
      expect(reloaded.status).not.toBe('queued')

      await waitFor(async () => mockSession.pi.promptCalls.length > 0, {
        description: 'prompt to be called on mock session',
        timeoutMs: PROMPT_DISPATCH_TIMEOUT_MS,
        intervalMs: 20,
      })
      mockSession.pi.simulateNormalEnd('started promptly')
      await waitFor(
        async () => {
          const exec = await Execution.mustFind(execution.id)
          return exec.status === 'completed'
        },
        {
          description: 'execution to reach completed status',
          timeoutMs: EXECUTION_COMPLETION_TIMEOUT_MS,
          intervalMs: 50,
        }
      )
      restoreCreateSession?.()
      restoreCreateSession = undefined
    },
    SQUAD_START_LATENCY_TEST_TIMEOUT_MS
  )
})
