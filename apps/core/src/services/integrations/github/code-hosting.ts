import { createHash } from 'node:crypto'
import { trackedResourceKey } from '@tau/shared'
import { resolveGitHubIssueReference } from './issue-reference'
import { resolveGitHubRelayAssignment } from './resolve-connection'
import type { CodeHostingAdapter } from '../code-hosting/registry'
import { githubApiGet } from '../../github/api-client'

const ISSUE_EVENTS = ['assigned', 'unassigned', 'updated', 'comment']
const PULL_REQUEST_EVENTS = [
  'updated',
  'merged',
  'closed',
  'review_requested',
  'reviewed',
  'comment',
  'review_comment',
  'ci_completed',
]

export const githubCodeHostingAdapter: CodeHostingAdapter = {
  integration: 'github',
  validateRepository: (repository) => /^[\w.-]+\/[\w.-]+$/.test(repository),
  async changeRequest(reference, squadId) {
    if (!reference.changeRequest) return null
    const pr = await githubApiGet<{ merged: boolean; base: { ref: string }; head: { ref: string; sha?: string } }>(
      `/repos/${reference.repository}/pulls/${reference.changeRequest.number}`,
      squadId,
      reference.connectionId
    )
    return pr
      ? {
          merged: pr.merged,
          headBranch: pr.head.ref,
          baseBranch: pr.base.ref,
          ...(pr.head.sha ? { headSha: pr.head.sha } : {}),
        }
      : null
  },
  async containsCommit(reference, squadId, base, commit) {
    const comparison = await githubApiGet<{ status: string }>(
      `/repos/${reference.repository}/compare/${encodeURIComponent(base)}...${commit}`,
      squadId,
      reference.connectionId
    )
    return !!comparison && ['identical', 'behind'].includes(comparison.status)
  },
  issueSubscriptions(reference, metadata) {
    const issue = resolveGitHubIssueReference(metadata, reference)
    if (!issue) return []
    return ISSUE_EVENTS.map((event) => ({
      id: `code-host-issue-${event}`,
      source: {
        integration: 'github',
        output: `issue.${event}`,
        version: 1,
        ...(issue.connectionId ? { connectionId: issue.connectionId } : {}),
      },
      match: { repository: { value: issue.repository }, 'issue.number': { value: issue.number } },
      deliver: { to: 'delivery-owner' as const, whenInactive: 'retain' as const },
    }))
  },
  subscriptions(reference) {
    return PULL_REQUEST_EVENTS.map((event) => ({
      id: `code-host-${event.replaceAll('_', '-')}`,
      source: {
        integration: 'github',
        output: `pull_request.${event}`,
        version: 1,
        ...(reference.connectionId ? { connectionId: reference.connectionId } : {}),
      },
      match: {
        repository: { value: reference.repository },
        'pullRequest.number': { value: reference.changeRequest!.number },
      },
      deliver: { to: 'delivery-owner' as const, whenInactive: 'retain' as const },
    }))
  },
  /** Ids hash the resource identity, so adding or removing a link never renumbers the others. */
  trackedSubscriptions(resource) {
    const hash = createHash('sha256').update(trackedResourceKey(resource)).digest('hex').slice(0, 12)
    const repository = resource.repository.trim().toLowerCase()
    const issue = resource.kind === 'issue'
    return (issue ? ISSUE_EVENTS : PULL_REQUEST_EVENTS).map((event) => ({
      id: `tracked-${hash}-${event.replaceAll('_', '-')}`,
      source: {
        integration: 'github',
        output: `${issue ? 'issue' : 'pull_request'}.${event}`,
        version: 1,
        ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
      },
      match: {
        repository: { value: repository },
        [issue ? 'issue.number' : 'pullRequest.number']: { value: resource.number },
      },
      deliver: { to: 'delivery-owner' as const, whenInactive: 'retain' as const },
    }))
  },
  async authorizeSquad(squadId, connectionId) {
    return !!(await resolveGitHubRelayAssignment(squadId, connectionId))
  },
}
