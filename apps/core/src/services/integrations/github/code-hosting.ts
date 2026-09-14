import { resolveGitHubIssueReference } from './issue-reference'
import type { CodeHostingAdapter } from '../code-hosting/registry'
import { githubApiGet } from '../../github/api-client'

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
    return ['assigned', 'unassigned', 'updated', 'comment'].map((event) => ({
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
    return [
      'updated',
      'merged',
      'closed',
      'review_requested',
      'reviewed',
      'comment',
      'review_comment',
      'ci_completed',
    ].map((event) => ({
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
}
