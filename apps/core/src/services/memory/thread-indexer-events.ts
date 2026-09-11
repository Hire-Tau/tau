/**
 * Thread Indexer Event Handlers
 *
 * Registers event listeners to automatically index agent threads
 * when executions complete. Each execution completion triggers a
 * re-index of the agent's full thread to capture new messages.
 */

import { eventEmitter } from '../../lib/infra/event-emitter'
import { Agent } from '../../entities/Agent'
import { indexAgentThread } from './thread-indexer'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('thread-indexer-events')

const AGENT_THREAD_INDEXING_ENABLED = false

let registered = false

/**
 * Register event handlers for automatic thread indexing.
 *
 * Call this once during application startup to enable
 * automatic indexing of agent threads after executions complete.
 */
export function registerThreadIndexerEvents(): void {
  if (!AGENT_THREAD_INDEXING_ENABLED) {
    log.info('Thread indexer events disabled')
    return
  }

  if (registered) {
    log.warn('Thread indexer events already registered')
    return
  }

  // Index agent thread when execution completes (captures new messages)
  eventEmitter.on('execution.completed', async ({ agentId }) => {
    try {
      const agent = await Agent.find(agentId)
      if (!agent?.squadId) {
        log.debug(`Skipping thread indexing for agent ${agentId} - no squad`)
        return
      }

      // Index the agent thread asynchronously (don't block execution completion)
      indexAgentThread(agent.squadId, agentId).catch((error) => {
        log.error(`Failed to index thread for agent ${agentId}:`, error)
      })
    } catch (error) {
      log.error(`Error handling execution.completed for agent ${agentId}:`, error)
    }
  })

  // Also index on failed/stopped executions since they have useful context
  eventEmitter.on('execution.failed', async ({ agentId }) => {
    try {
      const agent = await Agent.find(agentId)
      if (!agent?.squadId) return

      indexAgentThread(agent.squadId, agentId).catch((error) => {
        log.error(`Failed to index thread for agent ${agentId} (failed execution):`, error)
      })
    } catch (error) {
      log.error(`Error handling execution.failed for agent ${agentId}:`, error)
    }
  })

  eventEmitter.on('execution.stopped', async ({ agentId }) => {
    try {
      const agent = await Agent.find(agentId)
      if (!agent?.squadId) return

      indexAgentThread(agent.squadId, agentId).catch((error) => {
        log.error(`Failed to index thread for agent ${agentId} (stopped execution):`, error)
      })
    } catch (error) {
      log.error(`Error handling execution.stopped for agent ${agentId}:`, error)
    }
  })

  registered = true
  log.info('Thread indexer events registered')
}

/**
 * Check if thread indexer events are registered.
 */
export function isThreadIndexerEventsRegistered(): boolean {
  return registered
}

/**
 * Check whether agent thread indexing is currently enabled.
 */
export function isAgentThreadIndexingEnabled(): boolean {
  return AGENT_THREAD_INDEXING_ENABLED
}

/**
 * Reset registration state (for testing).
 */
export function _resetThreadIndexerEvents(): void {
  registered = false
}
