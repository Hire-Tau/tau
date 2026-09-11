import { isActiveExecutionStatus } from '../execution/status'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { Agent } from '../../entities/Agent'
import { providerHealth } from './registry'
import { providerRouteDecision } from './routing'
import { readAccountStore } from '../agent/account-store'
import { tryGetModelRuntime } from '../agent'
import { parseModelSpec, splitModelPriorityList } from '../../lib/utils/model-spec'
import { ERROR_HALT_QUESTION_IDS } from '../agents/resume'

const log = createLogger('provider-health-auto-restart')

const RESTART_INTERVAL_MS = Number(process.env.PROVIDER_HEALTH_RESTART_INTERVAL_MS) || 30_000

/** Base backoff window; doubled per consecutive restart. */
const BASE_BACKOFF_MS = 60_000
/** Absolute cap on a single backoff window. */
const MAX_BACKOFF_MS = 30 * 60_000
/** Max consecutive auto-restarts before requiring an explicit human "Continue". */
const MAX_AUTO_RESTARTS = 5

/**
 * `questionData.questions[0].id` values that indicate the agent entered `waiting-input` due to
 * provider exhaustion (set by `Execution.fail`). Other ids (e.g. `ask_human`) are genuine
 * user-question halts and must not be auto-restarted. Shared with the manual continue/Action Center.
 */
const EXHAUSTION_QUESTION_IDS = ERROR_HALT_QUESTION_IDS

/**
 * One sweep of the auto-restart policy: find `waiting-input` agents that were
 * halted by provider exhaustion and resume them once a provider in their
 * priority list is healthy again. Each candidate is wrapped in try/catch so a
 * single failure never aborts the sweep.
 *
 * Flap guards (all must hold before resuming):
 *  - `questionData` id is an exhaustion id (not `ask_human`).
 *  - Agent is not terminated.
 *  - The agent's squad (if any) is `active`.
 *  - No queued/running execution already exists (user already clicked "Try
 *    again").
 *  - At least one provider in the effective priority list is currently healthy.
 *  - Persisted exponential backoff in `agents.metadata`
 *    (`lastAutoRestartAt` / `autoRestartCount`) has elapsed and the consecutive
 *    cap has not been reached.
 */
export async function restartExhaustedAgentsOnce(): Promise<void> {
  const candidates = await Agent.list({ status: 'waiting-input' })
  for (const agent of candidates) {
    try {
      await maybeRestartAgent(agent)
    } catch (err) {
      log.warn(`Auto-restart for agent ${agent.id} failed:`, err)
    }
  }
}

async function maybeRestartAgent(agent: Agent): Promise<void> {
  // 1. Only restart exhaustion-induced waiting-input (exclude ask_human etc.).
  const questionId = agent.questionData?.questions?.[0]?.id
  if (!questionId || !EXHAUSTION_QUESTION_IDS.has(questionId)) return

  // 2. Re-check terminated (the work-stream-done cleanup handler may have
  //    terminated it between the list query and now).
  if (agent.status !== 'waiting-input') return

  // 3. Squad must be active (paused/archived squads are skipped).
  if (agent.squadId) {
    const squad = await agent.getSquad().catch(() => null)
    if (!squad || squad.status !== 'active') return
  }

  // 4. Skip if a queued/running execution already exists (user resumed).
  const active = await agent.getActiveExecution()
  if (active && isActiveExecutionStatus(active.status)) {
    return
  }

  // 5. At least one provider in the priority list must be healthy (recovery
  //    actually happened — don't restart into a still-exhausted set).
  const spec = await agent.getEffectiveModelSpec()
  const providers = splitModelPriorityList(spec).map((s) => {
    try {
      return parseModelSpec(s).provider
    } catch {
      return null
    }
  })
  const accountStore = readAccountStore()
  if (
    !providers.some(
      (provider) =>
        provider != null &&
        providerRouteDecision(
          provider,
          accountStore,
          providerHealth.snapshotRecords(),
          tryGetModelRuntime()?.hasConfiguredAuth(provider) ?? false
        )?.state === 'ready'
    )
  )
    return

  // 6. Persisted exponential backoff.
  const meta = (agent.metadata ?? {}) as Record<string, unknown>
  const count = typeof meta.autoRestartCount === 'number' ? meta.autoRestartCount : 0
  const lastAt = typeof meta.lastAutoRestartAt === 'number' ? meta.lastAutoRestartAt : 0
  if (count >= MAX_AUTO_RESTARTS) return
  const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** count, MAX_BACKOFF_MS)
  if (lastAt > 0 && Date.now() - lastAt < backoffMs) return

  // 7. Resume via the existing primitive: clear waiting-input, supersede the
  //    (failed) execution if any, and queue a fresh one. The worker's
  //    execution-poll picks up the queued execution; selectModelSpecForCurrentEnv
  //    re-evaluates health at resume and re-selects a recovered provider. If
  //    still all-exhausted, ModelSelectionError → Execution.fail → back to
  //    waiting-input (the backoff guard prevents a storm).
  await agent.clearWaitingInput()
  if (active) await active.supersede()
  await agent.queueExecution({})

  // Persist backoff metadata.
  await agent.update({
    metadata: { ...meta, lastAutoRestartAt: Date.now(), autoRestartCount: count + 1 },
  })

  log.info(`Auto-restarted agent ${agent.id} (questionId=${questionId}, attempt ${count + 1})`)
}

let runner: PeriodicRunner | null = null

/** Start the periodic auto-restart sweep. No-op if already running. */
export function startAutoRestartSweep(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'provider-health-auto-restart',
    intervalMs: RESTART_INTERVAL_MS,
    runImmediately: false,
    task: restartExhaustedAgentsOnce,
  })
  runner.start()
  log.info(`Auto-restart sweep started (interval ${RESTART_INTERVAL_MS}ms)`)
}

/** Stop the periodic auto-restart sweep. */
export async function stopAutoRestartSweep(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
