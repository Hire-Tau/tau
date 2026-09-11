import type { Squad } from '../../entities/Squad'

/**
 * A squad sandbox is considered "active" if any of its non-terminated top-level
 * agents sent a message within this window. Used to gate both warmup (don't
 * warm idle squads) and spec reconciliation (don't recreate a pod that's in
 * active use). Keep these two behaviors on the same window.
 */
export const RECENT_ACTIVITY_WINDOW_MS = 30 * 60 * 1000

type SquadWithAgents = Pick<Squad, 'getActiveAgents'>

/**
 * Whether any of the squad's active agents sent a message at or after `cutoff`.
 * Defaults the cutoff to {@link RECENT_ACTIVITY_WINDOW_MS} before now; pass an
 * explicit cutoff to keep a single timestamp consistent across a batch.
 */
export async function hasRecentAgentActivity(
  squad: SquadWithAgents,
  cutoff: number = Date.now() - RECENT_ACTIVITY_WINDOW_MS
): Promise<boolean> {
  const agents = await squad.getActiveAgents()
  return agents.some((agent) => agent.lastMessageAt != null && agent.lastMessageAt.getTime() >= cutoff)
}
