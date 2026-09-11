/**
 * The workspace directory the host runtime has ACTUALLY applied for a squad.
 *
 * A squad's host workspace override takes effect at the next sandbox start, but
 * the in-memory override cache is primed the instant a PATCH lands — and the api
 * process is not the process running the turn. Reading the cache back is
 * therefore a prediction of where agents WILL work, not where they are working;
 * right after a save it reports the new directory while every live agent is
 * still in the old one.
 *
 * So the ensure path (the only place the choice is really made) records the
 * directory it applied on the squad row, and the status endpoint prefers that
 * recorded value. `metadata.hostRuntime` is namespaced alongside the other
 * metadata sections and merged, never clobbered.
 */

import { Squad } from '../../../entities/Squad'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('host-active-workspace')

export interface HostRuntimeSquadMetadata {
  /** Workspace directory the last sandbox ensure actually applied. */
  activeWorkspacePath?: string
  /** ISO timestamp of that ensure. */
  appliedAt?: string
}

/** The recorded `metadata.hostRuntime` section, if any. */
export function hostRuntimeMetadata(squad: {
  metadata?: Record<string, unknown> | null
}): HostRuntimeSquadMetadata | undefined {
  const value = squad.metadata?.hostRuntime
  if (typeof value !== 'object' || value === null) return undefined
  return value as HostRuntimeSquadMetadata
}

/** The applied workspace path, or undefined when no host ensure has run yet. */
export function hostActiveWorkspacePath(squad: { metadata?: Record<string, unknown> | null }): string | undefined {
  const path = hostRuntimeMetadata(squad)?.activeWorkspacePath
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * Record the workspace path a host ensure just applied.
 *
 * Writes only when the value changed (an ensure runs on every turn, and an
 * unchanged rewrite would emit a `squad.updated` event each time). Never throws:
 * this is reporting metadata, and failing a turn's sandbox setup over it would
 * be a far worse outcome than a status endpoint falling back to the cache.
 */
export async function recordHostActiveWorkspacePath(squadId: string, workspacePath: string): Promise<void> {
  try {
    const squad = await Squad.find(squadId)
    if (!squad) return
    if (hostActiveWorkspacePath(squad) === workspacePath) return
    await Squad.update(squadId, {
      metadata: { hostRuntime: { activeWorkspacePath: workspacePath, appliedAt: new Date().toISOString() } },
    })
  } catch (err) {
    log.warn(`Could not record the applied host workspace path for squad ${squadId}:`, err)
  }
}
