/**
 * Agent Thread Indexer
 *
 * High-level orchestration for indexing agent conversation threads.
 * Provides convenience functions for indexing agent threads
 * and integration with the reindex scheduler.
 */

import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents } from '../../db/schema'
import { ThreadSource } from './sources/ThreadSource'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('thread-indexer')

// ============================================================================
// Types
// ============================================================================

export interface ThreadIndexStats {
  total: number
  indexed: number
  skipped: number
  failed: number
  errors: string[]
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Index all agent threads for a squad.
 *
 * This function:
 * 1. Gets all agents in the squad
 * 2. For each agent, indexes their full message history
 * 3. Includes metadata: agentId, agentType, workStreamId
 *
 * @param squadId - The squad ID to index threads for
 * @returns Statistics about the indexing operation
 */
export async function indexAgentThreads(squadId: string): Promise<ThreadIndexStats> {
  const source = ThreadSource.instance()

  // Get all agents in the squad
  const squadAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))

  if (squadAgents.length === 0) {
    log.info(`No agents found for squad ${squadId}`)
    return { total: 0, indexed: 0, skipped: 0, failed: 0, errors: [] }
  }

  const stats: ThreadIndexStats = {
    total: squadAgents.length,
    indexed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  log.info(`Indexing ${squadAgents.length} agent threads for squad ${squadId}`)

  for (const agent of squadAgents) {
    const result = await source.index(squadId, agent.id)

    if (result.success) {
      if (result.skipped) {
        stats.skipped++
      } else {
        stats.indexed++
      }
    } else {
      stats.failed++
      if (result.error) {
        stats.errors.push(`${agent.id}: ${result.error}`)
      }
    }
  }

  log.info(`Indexed ${stats.indexed} threads for squad ${squadId} (${stats.skipped} unchanged, ${stats.failed} failed)`)

  return stats
}

/**
 * Index a single agent's thread.
 *
 * Use this for on-demand indexing after an execution completes.
 *
 * @param squadId - The squad ID
 * @param agentId - The agent ID to index
 * @returns Whether the indexing was successful
 */
export async function indexAgentThread(squadId: string, agentId: string): Promise<boolean> {
  const source = ThreadSource.instance()
  const result = await source.index(squadId, agentId)

  if (result.success) {
    if (!result.skipped) {
      log.info(
        `Indexed agent ${agentId} thread (${result.chunksCreated} new, ${result.chunksPreserved ?? 0} preserved)`
      )
    }
    return true
  }

  log.error(`Failed to index agent ${agentId} thread: ${result.error}`)
  return false
}

/**
 * Check if an agent's thread has been indexed.
 *
 * @param squadId - The squad ID
 * @param agentId - The agent ID to check
 * @returns Whether the thread document exists
 */
export async function isAgentIndexed(squadId: string, agentId: string): Promise<boolean> {
  const source = ThreadSource.instance()
  return source.exists(squadId, agentId)
}

/**
 * Remove an agent's indexed thread.
 *
 * @param squadId - The squad ID
 * @param agentId - The agent ID to remove
 */
export async function removeAgentThread(squadId: string, agentId: string): Promise<void> {
  const source = ThreadSource.instance()
  await source.remove(squadId, agentId)
  log.info(`Removed thread index for agent ${agentId}`)
}
