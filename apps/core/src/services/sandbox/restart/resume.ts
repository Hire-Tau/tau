import { Agent } from '../../../entities/Agent'
import { createLogger } from '../../../lib/infra/logger'
import { SANDBOX_RESTART_QUESTION_ID } from './types'

const log = createLogger('sandbox-restart-resume')

export interface ResumeOptions {
  /** Injected readiness check (sandboxId -> ready?). Tests stub this. */
  isSandboxReady?: (sandboxId: string, agent: Agent) => Promise<boolean>
}

export async function defaultIsSandboxReady(sandboxId: string, agent: Agent): Promise<boolean> {
  try {
    // Import factory directly so spyOn in tests can intercept getSandboxManager/isK8sRuntime.
    const { getSandboxManager, isK8sRuntime } = await import('../factory')
    const { ensureAgentSandbox } = await import('../agent-warmup')

    // Re-ensure the agent's box (recreates a halted pod). Subagents fall through
    // to the status poll (the parent's resume rebuilds the shared box); an
    // inactive squad means the box can't be ready.
    const result = await ensureAgentSandbox(agent)
    if (result !== 'ensured' && result !== 'skipped-subagent') return false

    const manager = getSandboxManager()
    if (isK8sRuntime()) {
      const k8s = manager as import('../k8s/manager').K8sSandboxManager
      const status = await k8s.getSandboxStatus(sandboxId)
      return status.status === 'running'
    }

    return manager.hasSandbox(sandboxId)
  } catch (err) {
    log.debug(`Readiness check failed for ${sandboxId}:`, err)
    return false
  }
}

/**
 * One-shot startup drain for agents parked in waiting-input by the
 * pre-recovery-watch halt path. Removable once no deploy can have parked
 * agents.
 *
 * Parked SUBAGENTS may need a manual Continue: ensureAgentSandbox skips
 * subagent boxes, so if the parent's shared box only comes up after this
 * single pass, the subagent stays parked (the sentinel question carries a
 * user-facing Continue action).
 */
export async function drainSandboxHaltedAgentsOnce(opts: ResumeOptions = {}): Promise<void> {
  const isReady = opts.isSandboxReady ?? defaultIsSandboxReady
  const candidates = await Agent.list({ status: 'waiting-input' })

  for (const agent of candidates) {
    try {
      const questionId = agent.questionData?.questions?.[0]?.id
      if (questionId !== SANDBOX_RESTART_QUESTION_ID) continue
      if (agent.status !== 'waiting-input') continue

      if (agent.squadId) {
        const squad = await agent.getSquad().catch(() => null)
        if (!squad || squad.status !== 'active') continue
      }

      const active = await agent.getActiveExecution()
      if (active?.isActive) continue

      const sandboxId = await agent.getSandboxId()
      if (!(await isReady(sandboxId, agent))) continue

      await agent
        .recordMessage({
          role: 'human',
          content: '[System] Your sandbox has been recreated and is ready. Continue from where you left off.',
          metadata: { isSystem: true },
        })
        .catch(() => {})
      await agent.clearWaitingInput()
      await agent.queueExecution({})
      log.info(`Resumed agent ${agent.id} after sandbox restart`)
    } catch (err) {
      log.warn(`Resume for agent ${agent.id} failed:`, err)
    }
  }
}
