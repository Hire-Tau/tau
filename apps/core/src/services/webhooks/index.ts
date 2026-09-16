/**
 * Webhooks Module - Main Entry Point
 *
 * This module exports the webhook registry and handles
 * the registration of all webhook processors and handlers.
 */

export * from './types'
export { webhookRegistry } from './registry'
export { dispatchVerifiedWebhookContext, dispatchVerifiedWebhookEvent } from './dispatch'
export {
  storeWebhookEvent,
  markWebhookProcessed,
  markWebhookError,
  getWebhookEvent,
  listWebhookEvents,
  getLastRealWebhookDeliveryForRepo,
  getLastRealWebhookDeliveriesForRepos,
} from './store'

export { setGithubActionConfig, setLinearActionConfig } from './processors'
export { loadWebhookActionConfig, getBatcherConfig } from './action-config'
export { webhookBatcher, WebhookBatcher } from './batcher'
export type { BatchConfig, BatchEventConfig, BatcherConfig, BatchContext, PendingBatch } from './batcher'

// Import processors and handlers
import { webhookRegistry } from './registry'
import {
  githubProcessor,
  handleGithubPush,
  handleGithubPing,
  handleGithubPullRequestReview,
  handleGithubPullRequestReviewRequested,
  handleGithubPullRequestMerge,
  handleGithubPullRequestConflict,
  handleGithubIssuesAssigned,
  handleGithubIssuesUnassigned,
  handleGithubWorkflowRun,
  handleGithubIssueComment,
  handleGithubPullRequestReviewComment,
  linearProcessor,
  handleLinearIssueUpdate,
} from './processors'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('webhooks')

/**
 * Initialize all webhook processors and handlers.
 * Call this during app startup.
 */
export function initializeWebhooks(): void {
  log.info('Registering processors and handlers...')

  // Register GitHub processor
  webhookRegistry.registerProcessor(githubProcessor)
  log.info('Registered processor: github')

  // Register GitHub event handlers
  const githubHandlers = [
    ['push', handleGithubPush],
    ['ping', handleGithubPing],
    ['pull_request_review', handleGithubPullRequestReview],
    ['pull_request', handleGithubPullRequestReviewRequested],
    ['pull_request', handleGithubPullRequestMerge],
    ['pull_request', handleGithubPullRequestConflict],
    ['issues', handleGithubIssuesAssigned],
    ['issues', handleGithubIssuesUnassigned],
    ['workflow_run', handleGithubWorkflowRun],
    ['issue_comment', handleGithubIssueComment],
    ['pull_request_review_comment', handleGithubPullRequestReviewComment],
  ] as const

  for (const [event, handler] of githubHandlers) {
    webhookRegistry.registerHandler('github', event, handler)
  }
  log.info(
    `Registered ${githubHandlers.length} GitHub handlers: ${[...new Set(githubHandlers.map(([e]) => e))].join(', ')}`
  )

  // Register Linear processor
  webhookRegistry.registerProcessor(linearProcessor)
  log.info('Registered processor: linear')

  // Register Linear event handlers
  webhookRegistry.registerHandler('linear', 'Issue', handleLinearIssueUpdate)
  webhookRegistry.registerHandler('linear', 'Comment', handleLinearIssueUpdate)
  log.info('Registered 2 Linear handlers: Issue, Comment')

  log.info(`Initialization complete. Providers: ${webhookRegistry.getProviders().join(', ')}`)
}
