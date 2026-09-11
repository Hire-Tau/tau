import type { Squad } from '../../entities/Squad'
import { RECENT_ACTIVITY_WINDOW_MS, hasRecentAgentActivity } from './squad-activity'
import { hasRecentWorkStreamActivityForSandbox } from './work-stream-activity'
import { hasActiveLocalDeployments } from '../deploy/local-deployment-service'

/**
 * The minimal squad surface {@link shouldKeepSquadWarm} needs: identity (to
 * derive its box sandboxId), the always-on flag, and its active agents (for the
 * recent-activity signal).
 */
export type SquadForKeepWarm = Pick<Squad, 'id' | 'isSandboxAlwaysOn' | 'getActiveAgents'>

/**
 * The three async keep-warm signals, injectable for hermetic tests. Production
 * defaults delegate to the EXISTING helpers — this module composes them, it does
 * not reimplement them.
 */
export interface ShouldKeepSquadWarmDeps {
  /** Any active agent messaged at/after `cutoff`. Defaults to {@link hasRecentAgentActivity}. */
  hasRecentAgentActivity?: (squad: SquadForKeepWarm, cutoff: number) => Promise<boolean>
  /** The squad box has an active local deployment. Defaults to {@link hasActiveLocalDeployments}. */
  hasActiveLocalDeployments?: (sandboxId: string) => Promise<boolean>
  /** The squad box's work stream has a recently-active member. Defaults to {@link hasRecentWorkStreamActivityForSandbox}. */
  hasRecentWorkStreamActivity?: (sandboxId: string) => Promise<boolean>
}

/**
 * The single shared "keep this squad's box warm" predicate, consumed by BOTH
 * the squad warmup (`warmupActiveSquadSandboxes`) and the idle reaper's
 * squad-box keepAlive (`vm/lifecycle.ts`) so the two sides cannot drift and
 * churn a box (park → immediate re-warm) every tick.
 *
 * Keep warm iff ANY of: the squad is always-on, an agent messaged within the
 * recent-activity window ({@link RECENT_ACTIVITY_WINDOW_MS}), the box has an
 * active local deployment, or its work stream is recently active. Cheapest
 * (sync, no I/O) branch first; the async signals short-circuit in order.
 *
 * The work-stream signal is a no-op for squad boxes (it only matches `agent_`
 * ids) — it is composed here for exact parity with the reaper's prior generic
 * keepAlive (`deploy ∨ workStream`), keeping this a strict superset.
 */
export async function shouldKeepSquadWarm(
  squad: SquadForKeepWarm,
  now: number,
  deps: ShouldKeepSquadWarmDeps = {}
): Promise<boolean> {
  if (squad.isSandboxAlwaysOn) return true

  const recentAgentActivity = deps.hasRecentAgentActivity ?? hasRecentAgentActivity
  const activeLocalDeployments = deps.hasActiveLocalDeployments ?? hasActiveLocalDeployments
  const recentWorkStream = deps.hasRecentWorkStreamActivity ?? hasRecentWorkStreamActivityForSandbox

  // Mirrors Squad.getSandboxId(squad.id) — the canonical squad box id — without
  // importing the (heavy) Squad value/module.
  const sandboxId = `squad_${squad.id}`

  if (await recentAgentActivity(squad, now - RECENT_ACTIVITY_WINDOW_MS)) return true
  if (await activeLocalDeployments(sandboxId)) return true
  if (await recentWorkStream(sandboxId)) return true
  return false
}
