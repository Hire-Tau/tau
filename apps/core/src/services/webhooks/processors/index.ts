/**
 * Webhook Processors Index
 *
 * Export all webhook processor implementations.
 */

export {
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
  setGithubActionConfig,
} from './github'

export { linearProcessor, handleLinearIssueUpdate, setLinearActionConfig } from './linear'
