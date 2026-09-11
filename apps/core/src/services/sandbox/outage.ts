/**
 * Sandbox outage detection for the exec layer.
 *
 * When a bash/file operation against a sandbox fails, the live pod status is
 * the tiebreaker between "the command/transport hiccuped" and "the box is
 * down". For a down box we return a structured, agent-readable error (instead
 * of raw connection garbage), register a recovery watch so the agent gets
 * notified when the box is back, and kick off re-ensure in the background.
 *
 * See docs/history/superpowers/specs/2026-07-08-sandbox-outage-recovery-watch-design.md.
 */

import { createLogger } from '../../lib/infra/logger'
import { sandboxRecoveryWatch, type RegisterWatchInput } from './recovery-watch'
import { getSquadIdFromSandbox } from './types'

const log = createLogger('sandbox-outage')

/** Live pod statuses that mean the box itself is healthy — the failure was the command/transport. */
const HEALTHY_STATUSES = new Set(['running'])

/** Statuses that mean an actual crash (charge the crash budget); everything else non-healthy is a plain outage. */
const CRASH_STATUSES = new Set(['failed'])

export class SandboxOutageError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE'
  readonly secondaryFailures: Error[] = []
  constructor(
    readonly sandboxId: string,
    message: string,
    options: ErrorOptions & { status: string; reason?: string }
  ) {
    super(message, options)
    this.name = 'SandboxOutageError'
    this.status = options.status
    this.reason = options.reason
  }
  readonly status: string
  readonly reason?: string
}

export function attachSecondaryFailure(primary: Error, secondary: Error): Error {
  const target = primary as Error & { secondaryFailures?: Error[] }
  target.secondaryFailures = [...(target.secondaryFailures ?? []), secondary]
  return target
}

export interface SandboxOutageDeps {
  /** Live (never cached) status for the sandbox — K8s queryPodStatus. */
  getLiveStatus: (sandboxId: string) => Promise<{ status: string; reason?: string; startedAt?: string }>
  registerWatch: (input: RegisterWatchInput) => Promise<void>
  /** Fire-and-forget re-ensure of the dead box. */
  triggerRecovery: (sandboxId: string, agentId?: string) => void
}

export interface MapExecFailureInput {
  sandboxId: string
  /** Agent to wake when the box is back. Omit when unknown — no watch is registered. */
  agentId?: string
  original: Error
}

/** Derive the owning agent id from a light-box sandbox id (`agent_<id>`), else null. */
export function agentIdFromSandboxId(sandboxId: string): string | null {
  return sandboxId.startsWith('agent_') ? sandboxId.slice('agent_'.length) : null
}

function describeBox(sandboxId: string): string {
  if (getSquadIdFromSandbox(sandboxId)) return 'the shared squad box'
  if (sandboxId.startsWith('agent_')) return 'your private box'
  return 'the sandbox'
}

function buildOutageMessage(opts: { sandboxId: string; reason?: string; watched: boolean }): string {
  const { sandboxId, reason, watched } = opts
  const followUp = watched
    ? "You'll get a system notification when it's back."
    : 'You can check its status with the sandbox_status tool.'
  return (
    `Sandbox \`${sandboxId}\` (${describeBox(sandboxId)}) is currently unavailable` +
    `${reason ? ` (reason: ${reason})` : ''}. Automatic recovery has started — ${followUp} ` +
    'Until then, bash, file, and browser commands against this box will fail; web, memory, messaging, ' +
    'and planning tools still work.'
  )
}

/**
 * Map an exec failure to a structured outage error when the box is actually
 * down; return the original error untouched when the box is healthy or when
 * the status check itself fails (fail open — never mask a real command error
 * behind a wrong outage claim).
 */
export async function mapSandboxExecFailure(input: MapExecFailureInput, deps: SandboxOutageDeps): Promise<Error> {
  const { sandboxId, agentId, original } = input

  let status: { status: string; reason?: string; startedAt?: string }
  try {
    status = await deps.getLiveStatus(sandboxId)
  } catch (err) {
    log.debug(`Live status check failed for ${sandboxId}; passing original error through:`, err)
    return original
  }

  if (HEALTHY_STATUSES.has(status.status)) return original

  const crash = CRASH_STATUSES.has(status.status)
  log.warn(
    `Exec failure on ${sandboxId} attributed to sandbox outage (status: ${status.status}` +
      `${status.reason ? `, reason: ${status.reason}` : ''})`
  )

  let watched = false
  if (agentId) {
    try {
      await deps.registerWatch({
        agentId,
        sandboxIds: [sandboxId],
        reason: status.reason,
        crash,
        ...(status.startedAt ? { observedAt: new Date(status.startedAt) } : {}),
      })
      watched = true
    } catch (err) {
      log.warn(`Failed to register recovery watch for agent ${agentId}:`, err)
    }
  }

  deps.triggerRecovery(sandboxId, agentId)

  return new SandboxOutageError(sandboxId, buildOutageMessage({ sandboxId, reason: status.reason, watched }), {
    status: status.status,
    reason: status.reason,
    cause: original,
  })
}

// ── Default (production) wiring ──────────────────────────────────────────────

/**
 * Outage deps bound to a live sandbox manager — the manager the exec ops
 * already hold is the source of truth for live pod status.
 */
export function createManagerOutageDeps(manager: {
  getSandboxStatus: (sandboxId: string) => Promise<{ status: string; reason?: string; startedAt?: string }>
}): SandboxOutageDeps {
  return {
    getLiveStatus: (sandboxId) => manager.getSandboxStatus(sandboxId),
    registerWatch: (input) => sandboxRecoveryWatch.register(input),
    triggerRecovery: (sandboxId, agentId) => {
      void recoverSandbox(sandboxId, agentId).catch((err) => {
        log.warn(`Background recovery trigger failed for ${sandboxId}:`, err)
      })
    },
  }
}

/** Re-ensure a dead box in the background. Squad boxes re-ensure by squad id; agent boxes via the agent. */
async function recoverSandbox(sandboxId: string, agentId?: string): Promise<void> {
  const squadId = getSquadIdFromSandbox(sandboxId)
  if (squadId) {
    const { ensureSquadSandbox } = await import('./ensure')
    await ensureSquadSandbox(squadId)
    return
  }

  const ownerAgentId = agentId ?? agentIdFromSandboxId(sandboxId)
  if (!ownerAgentId) return
  const { Agent } = await import('../../entities/Agent')
  const agent = await Agent.find(ownerAgentId)
  if (!agent) return
  const { ensureAgentSandbox } = await import('./agent-warmup')
  await ensureAgentSandbox(agent)
}
