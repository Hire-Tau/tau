import { consultantSandboxSquadId } from './consultant-sandbox'
/**
 * Sandbox recovery watch.
 *
 * System-level (host-side) replacement for the halt/resume flow when a sandbox
 * dies under a working agent. Instead of failing the execution and parking the
 * agent, callers register a watch (agentId → sandbox ids it depends on); the
 * watch notifies the agent once ALL watched boxes are back — pod running AND
 * devbox-ready — via Agent.sendMessage, which steers a live session or queues
 * an execution for an idle agent.
 *
 * Completion is event-driven (sandbox.status / sandbox.ensured) with a
 * periodic sweep as fallback. See
 * docs/history/superpowers/specs/2026-07-08-sandbox-outage-recovery-watch-design.md.
 */

import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { isSessionActive } from '../execution/session-state'
import { MAX_SANDBOX_RESTARTS, META_COUNT } from './restart/types'
import { SandboxRecoveryStore } from './recovery-store'

const log = createLogger('sandbox-recovery-watch')

const SWEEP_INTERVAL_MS = Number(process.env.SANDBOX_RECOVERY_SWEEP_INTERVAL_MS) || 30_000
/** How long to keep watching before telling the agent the box is still down. */
const GIVE_UP_TIMEOUT_MS = Number(process.env.SANDBOX_RECOVERY_GIVE_UP_MS) || 15 * 60_000

export interface RecoveryWatchEntry {
  agentId: string
  sandboxIds: Set<string>
  /** Outage start (first registration) — downtime is measured from here. */
  since: number
  reason?: string
  /** Crash count after this outage was counted (0 = never counted). */
  crashCount: number
  crashCharged: boolean
  episodeIds: Map<string, string>
  startedAtBySandbox: Map<string, number>
}

export interface RecoveryWatchDeps {
  /** Live readiness: pod running AND devboxReady (never the in-memory cache). */
  isSandboxReady: (sandboxId: string) => Promise<boolean>
  /** Wake delivery — steers a live session or queues an execution (Agent.sendMessage). */
  notifyAgent: (
    agentId: string,
    content: string,
    identity: {
      sandboxId: string
      recoveryEpisodeId: string
      recoveryNotificationKind: 'recovered' | 'still_unavailable'
    }
  ) => Promise<unknown>
  /** Record-only delivery for over-budget agents — no execution queued. */
  recordAgentMessage: (
    agentId: string,
    content: string,
    identity: {
      sandboxId: string
      recoveryEpisodeId: string
      recoveryNotificationKind: 'recovered' | 'still_unavailable'
    }
  ) => Promise<unknown>
  /** Whether the agent has a live session right now (steerable without waking it). */
  isAgentActive: (agentId: string) => boolean
  getCrashCount: (agentId: string) => Promise<number>
  now: () => number
}

export interface RegisterWatchInput {
  agentId: string
  sandboxIds: string[]
  /** Short pod-level reason when known, e.g. 'OOMKilled'. */
  reason?: string
  /** True when the registration stems from an observed crash (counts toward the budget). */
  crash?: boolean
  /** Stable authoritative start of the failed pod/box generation, when available. */
  observedAt?: Date
}

export class SandboxRecoveryWatch {
  private readonly entries = new Map<string, RecoveryWatchEntry>()

  constructor(
    private readonly deps: RecoveryWatchDeps,
    private readonly store: SandboxRecoveryStore = new SandboxRecoveryStore()
  ) {}

  get size(): number {
    return this.entries.size
  }

  getDiagnostics(): { active: number; oldestAgeSeconds: number } {
    let oldestSince = this.deps.now()
    for (const entry of this.entries.values()) oldestSince = Math.min(oldestSince, entry.since)
    return {
      active: this.entries.size,
      oldestAgeSeconds: this.entries.size === 0 ? 0 : Math.max(0, (this.deps.now() - oldestSince) / 1000),
    }
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId)
  }

  get(agentId: string): RecoveryWatchEntry | undefined {
    return this.entries.get(agentId)
  }

  /**
   * Register (or extend) a watch for an agent. Re-registrations during the
   * same outage merge sandbox ids and keep the original start time; the crash
   * budget is charged at most once per outage.
   */
  async register(input: RegisterWatchInput): Promise<void> {
    let sandboxIds = input.sandboxIds
    if (!input.observedAt) {
      const keep = await Promise.all(
        sandboxIds.map(async (sandboxId) => {
          if (!(await this.store.hasClosedEpisode(sandboxId))) return true
          // Runtimes without a stable box-generation timestamp (Docker, VM, and some K8s
          // states) derive the transition from live readiness: a delayed retry observed
          // after recovery belongs to the closed generation and must not allocate another.
          return !(await this.deps.isSandboxReady(sandboxId).catch(() => false))
        })
      )
      sandboxIds = sandboxIds.filter((_, index) => keep[index])
      if (!sandboxIds.length) return
    }

    const result = await this.store.register({
      ...input,
      sandboxIds,
      observedAt: input.observedAt ?? new Date(this.deps.now()),
    })
    const existing = this.entries.get(input.agentId)
    const entry: RecoveryWatchEntry = existing ?? {
      agentId: input.agentId,
      sandboxIds: new Set(),
      episodeIds: new Map(),
      startedAtBySandbox: new Map(),
      since: this.deps.now(),
      reason: input.reason,
      crashCount: 0,
      crashCharged: false,
    }
    for (const registration of result.registrations) {
      entry.sandboxIds.add(registration.sandboxId)
      entry.episodeIds.set(registration.sandboxId, registration.episodeId)
      entry.startedAtBySandbox.set(registration.sandboxId, registration.startedAt.getTime())
      if (registration.crashChargeWinner) {
        entry.crashCharged = true
        entry.crashCount = registration.crashCount ?? entry.crashCount
      }
    }
    this.entries.set(input.agentId, entry)
    log.info(`Watching sandbox recovery for agent ${input.agentId} (${[...entry.sandboxIds].join(', ')})`)
  }

  /** Check a single agent's durable subscriptions and drain prepared notifications. */
  async checkAgent(agentId: string): Promise<void> {
    await this.hydrate({ agentId })
    const entry = this.entries.get(agentId)
    if (entry) {
      const observations = await Promise.all(
        [...entry.sandboxIds].map(async (sandboxId) => {
          const elapsed = this.deps.now() - (entry.startedAtBySandbox.get(sandboxId) ?? entry.since)
          const expired = elapsed > GIVE_UP_TIMEOUT_MS
          const ready = !expired && (await this.deps.isSandboxReady(sandboxId).catch(() => false))
          return { sandboxId, elapsed, expired, ready }
        })
      )
      const allRecoverableDependenciesReady = observations.every((observation) => observation.ready)
      if (!allRecoverableDependenciesReady && observations.every((observation) => !observation.expired)) return

      for (const observation of observations) {
        const { sandboxId, elapsed, expired } = observation
        if (!expired && !allRecoverableDependenciesReady) continue
        const episodeId = entry.episodeIds.get(sandboxId)
        if (!episodeId) continue
        const ready = !expired
        const single: RecoveryWatchEntry = {
          ...entry,
          sandboxIds: new Set([sandboxId]),
          episodeIds: new Map([[sandboxId, episodeId]]),
          startedAtBySandbox: new Map([[sandboxId, entry.startedAtBySandbox.get(sandboxId) ?? entry.since]]),
        }
        const kind = ready ? 'recovered' : 'still_unavailable'
        const crashCount = await this.deps.getCrashCount(agentId).catch(() => entry.crashCount)
        await this.store.prepareNotification({
          episodeId,
          agentId,
          kind,
          content: ready
            ? buildRecoveredMessage(single, elapsed, crashCount)
            : buildStillUnavailableMessage(single, elapsed),
          recordOnly: ready ? crashCount > MAX_SANDBOX_RESTARTS : !this.deps.isAgentActive(agentId),
          now: new Date(this.deps.now()),
        })
        entry.sandboxIds.delete(sandboxId)
        entry.episodeIds.delete(sandboxId)
        entry.startedAtBySandbox.delete(sandboxId)
      }
      if (!entry.sandboxIds.size) this.entries.delete(agentId)
    }
    await this.drain(agentId)
  }

  private async drain(agentId?: string): Promise<void> {
    const claims = await this.store.claimDue({ agentId })
    for (const claim of claims) {
      const identity = {
        sandboxId: claim.sandboxId,
        recoveryEpisodeId: claim.episodeId,
        recoveryNotificationKind: claim.notificationKind,
      }
      try {
        const delivered = claim.recordOnly
          ? await this.deps.recordAgentMessage(claim.agentId, claim.content, identity)
          : await this.deps.notifyAgent(claim.agentId, claim.content, identity)
        const result = delivered && typeof delivered === 'object' ? (delivered as Record<string, unknown>) : null
        const metadata =
          result?.metadata && typeof result.metadata === 'object' ? (result.metadata as Record<string, unknown>) : null
        await this.store.markDelivered(claim.episodeId, claim.agentId, claim.claimToken, {
          ...(typeof result?.id === 'string' ? { messageId: result.id } : {}),
          ...(typeof metadata?.executionId === 'string' ? { executionId: metadata.executionId } : {}),
        })
      } catch (err) {
        log.warn(`Failed to deliver sandbox recovery notification to agent ${claim.agentId} (will replay):`, err)
      }
    }
  }

  private async hydrate(filters: { agentId?: string; sandboxId?: string } = {}): Promise<void> {
    for (const row of await this.store.listWatching(filters)) {
      const entry = this.entries.get(row.agentId) ?? {
        agentId: row.agentId,
        sandboxIds: new Set<string>(),
        episodeIds: new Map<string, string>(),
        startedAtBySandbox: new Map<string, number>(),
        since: row.startedAt.getTime(),
        reason: row.reason ?? undefined,
        crashCount: 0,
        crashCharged: row.crashCharged,
      }
      entry.sandboxIds.add(row.sandboxId)
      entry.episodeIds.set(row.sandboxId, row.episodeId)
      entry.startedAtBySandbox.set(row.sandboxId, row.startedAt.getTime())
      entry.crashCharged ||= row.crashCharged
      entry.since = Math.min(entry.since, row.startedAt.getTime())
      this.entries.set(row.agentId, entry)
    }
  }

  /** Sweep fallback — check every watched agent. */
  async checkAllOnce(): Promise<void> {
    await this.hydrate()
    await this.drain()
    for (const agentId of [...this.entries.keys()]) {
      try {
        await this.checkAgent(agentId)
      } catch (err) {
        log.warn(`Recovery watch check failed for agent ${agentId}:`, err)
      }
    }
  }

  /** Event-driven path: a sandbox's status changed — check only watches that include it. */
  async handleSandboxStatusEvent(sandboxId: string): Promise<void> {
    await this.hydrate({ sandboxId })
    for (const entry of [...this.entries.values()]) {
      if (entry.sandboxIds.has(sandboxId)) {
        await this.checkAgent(entry.agentId)
      }
    }
  }

  /** Event-driven path: an agent's sandboxes were (re-)ensured — check its watch. */
  async handleSandboxEnsuredEvent(agentId: string): Promise<void> {
    await this.checkAgent(agentId)
  }
}

function formatDowntime(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 120) return `${seconds}s`
  return `${(seconds / 60).toFixed(1).replace(/\.0$/, '')} minutes`
}

function describeBoxes(entry: RecoveryWatchEntry): string {
  return [...entry.sandboxIds].map((id) => `\`${id}\``).join(' and ')
}

function buildRecoveredMessage(entry: RecoveryWatchEntry, elapsedMs: number, crashCount: number): string {
  const boxes = describeBoxes(entry)
  const plural = entry.sandboxIds.size > 1
  let message =
    `[System] Sandbox ${boxes} ${plural ? 'are' : 'is'} back online (down ~${formatDowntime(elapsedMs)}). ` +
    'Bash and file commands will work again.'
  if (crashCount >= 2) {
    message +=
      ` Note: this sandbox has crashed ${crashCount} times recently — it may be unstable; ` +
      'consider lighter commands (narrower test/lint scope, smaller builds).'
  }
  return message
}

function buildStillUnavailableMessage(entry: RecoveryWatchEntry, elapsedMs: number): string {
  const boxes = describeBoxes(entry)
  const plural = entry.sandboxIds.size > 1
  return (
    `[System] Sandbox ${boxes} ${plural ? 'are' : 'is'} still unavailable after ~${formatDowntime(elapsedMs)}` +
    `${entry.reason ? ` (last reason: ${entry.reason})` : ''}. Recovery keeps running in the background, but you ` +
    'will not receive further automatic notifications for this outage. You can check again with the ' +
    'sandbox_status tool, keep working with non-sandbox tools, or report the outage to your contacts.'
  )
}

// ── Default (production) wiring ──────────────────────────────────────────────

export async function defaultIsSandboxReady(sandboxId: string): Promise<boolean> {
  // Re-ensure before checking: this is what actually RECREATES a dead box —
  // squad boxes also get recreated by the squad reconciler, but per-agent
  // boxes have no other owner once their session's ensure has passed.
  // ensureSandbox dedupes concurrent calls, so this is cheap on a live box.
  try {
    const { getSquadIdFromSandbox } = await import('./types')
    const squadId = getSquadIdFromSandbox(sandboxId)
    if (squadId) {
      const { ensureSquadSandbox } = await import('./ensure')
      await ensureSquadSandbox(squadId)
    } else if (consultantSandboxSquadId(sandboxId)) {
      const { ensureConsultantSandbox } = await import('./consultant-warmup')
      await ensureConsultantSandbox(consultantSandboxSquadId(sandboxId)!)
    } else if (sandboxId.startsWith('agent_')) {
      const { Agent } = await import('../../entities/Agent')
      const agent = await Agent.find(sandboxId.slice('agent_'.length))
      if (agent) {
        const { ensureAgentSandbox } = await import('./agent-warmup')
        const result = await ensureAgentSandbox(agent)
        if (result !== 'ensured') return false
      }
    }
  } catch (err) {
    log.debug(`Re-ensure during readiness check failed for ${sandboxId}:`, err)
    return false
  }

  const { getSandboxManager, isRemoteSandboxRuntime } = await import('./factory')
  const manager = getSandboxManager()

  // Remote runtimes (k8s + vm) expose a live getSandboxStatus with devboxReady, so
  // "back" means running AND devbox-ready — never wake an agent into the
  // package-install window. Docker has only the coarse hasSandbox tracking.
  if (isRemoteSandboxRuntime()) {
    const remote = manager as unknown as {
      getSandboxStatus(id: string): Promise<{ status: string; devboxReady?: boolean }>
    }
    const status = await remote.getSandboxStatus(sandboxId)
    return status.status === 'running' && status.devboxReady === true
  }

  return manager.hasSandbox(sandboxId)
}

async function defaultNotifyAgent(
  agentId: string,
  content: string,
  identity: {
    sandboxId: string
    recoveryEpisodeId: string
    recoveryNotificationKind: 'recovered' | 'still_unavailable'
  }
): Promise<unknown> {
  const { Agent } = await import('../../entities/Agent')
  const agent = await Agent.mustFind(agentId)
  // sendMessage handles all delivery states: steers a running session, queues
  // an execution for idle/waiting agents.
  return agent.sendRecoveryMessageOnce(content, identity)
}

async function defaultRecordAgentMessage(
  agentId: string,
  content: string,
  identity: {
    sandboxId: string
    recoveryEpisodeId: string
    recoveryNotificationKind: 'recovered' | 'still_unavailable'
  }
): Promise<unknown> {
  const { Agent } = await import('../../entities/Agent')
  const agent = await Agent.mustFind(agentId)
  return agent.sendRecoveryMessageOnce(content, identity, { recordOnly: true })
}

async function defaultGetCrashCount(agentId: string): Promise<number> {
  const { Agent } = await import('../../entities/Agent')
  const agent = await Agent.mustFind(agentId)
  const count = (agent.metadata ?? {})[META_COUNT]
  return typeof count === 'number' ? count : 0
}

export const defaultRecoveryWatchDeps: RecoveryWatchDeps = {
  isSandboxReady: defaultIsSandboxReady,
  notifyAgent: defaultNotifyAgent,
  recordAgentMessage: defaultRecordAgentMessage,
  isAgentActive: isSessionActive,
  getCrashCount: defaultGetCrashCount,
  now: Date.now,
}

export const sandboxRecoveryWatch = new SandboxRecoveryWatch(defaultRecoveryWatchDeps)

let runner: PeriodicRunner | null = null
let unsubscribes: Array<() => void> = []

/** Start the recovery watch: event subscriptions + periodic sweep fallback. */
export function startSandboxRecoveryWatch(watch: SandboxRecoveryWatch = sandboxRecoveryWatch): void {
  if (runner) return

  unsubscribes = [
    eventEmitter.on('sandbox.status', ({ sandboxId }) => {
      watch.handleSandboxStatusEvent(sandboxId).catch((err) => log.warn('sandbox.status watch check failed:', err))
    }),
    eventEmitter.on('sandbox.ensured', ({ agentId }) => {
      watch.handleSandboxEnsuredEvent(agentId).catch((err) => log.warn('sandbox.ensured watch check failed:', err))
    }),
  ]

  watch.checkAllOnce().catch((err) => log.warn('sandbox recovery startup replay failed:', err))

  runner = createPeriodicRunner({
    name: 'sandbox-recovery-watch',
    intervalMs: SWEEP_INTERVAL_MS,
    runImmediately: false,
    task: () => watch.checkAllOnce(),
  })
  runner.start()
  log.info(`Sandbox recovery watch started (sweep interval ${SWEEP_INTERVAL_MS}ms)`)
}

export async function stopSandboxRecoveryWatch(): Promise<void> {
  for (const unsub of unsubscribes) unsub()
  unsubscribes = []
  if (!runner) return
  await runner.stop()
  runner = null
}
