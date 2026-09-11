import { randomUUID } from 'crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { acquireAgentQueueLock, createQueuedAdmission } from '../execution/agent-admission'
import { ACTIVE_EXECUTION_STATUSES } from '../execution/status'
import { maintenanceStore } from '../maintenance/store'

/**
 * `questionData.questions[0].id` values that `Execution.fail` sets when an agent halts on provider
 * exhaustion or a rate limit (vs. a genuine `ask_human` question). These are "error halts" that can
 * be resumed (individually or in bulk) once the provider recovers.
 */
export const ERROR_HALT_QUESTION_IDS = new Set(['all_providers_exhausted', 'rate_limit'])

function isErrorHaltState(status: string, questionData: unknown): boolean {
  if (status !== 'waiting-input') return false
  const data = questionData as { questions?: Array<{ id?: string }> } | null
  const id = data?.questions?.[0]?.id
  return !!id && ERROR_HALT_QUESTION_IDS.has(id)
}

export function isErrorHalted(agent: Agent): boolean {
  return isErrorHaltState(agent.status, agent.questionData)
}

/** Human-readable reason an agent is halted (the exhaustion/rate-limit message). */
export function errorHaltReason(agent: Agent): string {
  return agent.questionData?.questions?.[0]?.question ?? 'Halted by a provider error.'
}

/** All agents currently halted by a provider/rate-limit error (squad-bound and squad-less). */
export async function listErrorHaltedAgents(): Promise<Agent[]> {
  const agents = await Agent.list({ status: 'waiting-input' })
  return agents.filter(isErrorHalted)
}

export type ResumeHaltedResult = 'resumed' | 'stale' | 'forbidden'

let beforeAuthoritativeLockHook: ((agentId: string) => Promise<void>) | undefined
export function setResumeHaltedBeforeAuthoritativeLockHookForTests(
  hook: ((agentId: string) => Promise<void>) | undefined
): void {
  beforeAuthoritativeLockHook = hook
}

/**
 * Atomically authorize and resume the current authoritative halt generation.
 * The maintenance lock and per-agent queue lock serialize every execution producer; the
 * authoritative agent row then fences termination, reassignment, duplicate replay, and stale cards.
 */
export async function resumeHaltedAgentAuthoritatively(
  agentId: string,
  authorize: (target: { ownerUserId: string | null; squadId: string | null }) => Promise<boolean> = async () => true
): Promise<ResumeHaltedResult> {
  const result = await db.transaction(async (tx) => {
    const { state: maintenance, databaseNow } = await maintenanceStore.readLocked(tx)
    await acquireAgentQueueLock(tx, agentId)
    await beforeAuthoritativeLockHook?.(agentId)
    const [target] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update')
    if (
      !target ||
      target.status !== 'waiting-input' ||
      target.pendingDormancyAt ||
      !isErrorHaltState(target.status, target.questionData)
    ) {
      return { outcome: 'stale' as const }
    }
    if (!(await authorize({ ownerUserId: target.ownerUserId, squadId: target.squadId }))) {
      return { outcome: 'forbidden' as const }
    }

    const [active] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.agentId, agentId), inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES])))
      .limit(1)
    if (active) return { outcome: 'stale' as const }

    const [previous] = await tx
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(eq(executions.agentId, agentId))
      .orderBy(desc(executions.startedAt), desc(executions.id))
      .limit(1)
    if (previous?.status === 'failed') {
      await tx
        .update(executions)
        .set({ status: 'completed', endedAt: databaseNow })
        .where(and(eq(executions.id, previous.id), eq(executions.status, 'failed')))
    }

    const metadata = (target.metadata ?? {}) as Record<string, unknown>
    await tx
      .update(agents)
      .set({
        status: 'idle',
        questionData: null,
        metadata:
          metadata.autoRestartCount || metadata.lastAutoRestartAt
            ? { ...metadata, autoRestartCount: 0, lastAutoRestartAt: 0 }
            : metadata,
        updatedAt: databaseNow,
      })
      .where(eq(agents.id, agentId))

    const executionId = randomUUID()
    const status = maintenance.effective ? ('waiting-maintenance' as const) : ('queued' as const)
    const { executionFlowContext } = await import('../workflows/usage')
    const { assertAgentWorkStreamNotPaused } = await import('../work-streams/pause')
    await assertAgentWorkStreamNotPaused(agentId, tx)
    const flowContext = await executionFlowContext(agentId, tx)
    await tx.insert(executions).values({
      flowContext,
      id: executionId,
      agentId,
      status,
      maintenanceGeneration: maintenance.effective ? maintenance.generation : null,
      maintenanceQueuedAt: maintenance.effective ? databaseNow : null,
    })
    await createQueuedAdmission(tx, { agentId, executionId, state: status })
    return {
      outcome: 'resumed' as const,
      executionId,
      executionStatus: status,
      previousExecutionId: previous?.status === 'failed' ? previous.id : null,
      squadId: target.squadId,
    }
  })

  if (result.outcome === 'resumed') {
    eventEmitter.emit('agent.updated', { agentId, squadId: result.squadId })
    if (result.previousExecutionId) {
      eventEmitter.emit('execution.updated', {
        executionId: result.previousExecutionId,
        agentId,
        status: 'completed',
      })
      eventEmitter.emit('execution.completed', {
        executionId: result.previousExecutionId,
        agentId,
        status: 'completed',
      })
    }
    const payload = { executionId: result.executionId, agentId, status: result.executionStatus }
    eventEmitter.emit('execution.created', payload)
    if (result.executionStatus === 'queued') eventEmitter.emit('execution.queued', payload)
  }
  return result.outcome
}

/** Backward-compatible boolean wrapper for internal callers. */
export async function resumeHaltedAgent(agent: Agent): Promise<boolean> {
  return (await resumeHaltedAgentAuthoritatively(agent.id)) === 'resumed'
}
