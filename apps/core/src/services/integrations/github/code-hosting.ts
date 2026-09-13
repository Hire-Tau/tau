import { codeHostReferenceSchema, integrationValueAt } from '@tau/shared'
import type { CodeHostingAdapter } from '../code-hosting/registry'
import { githubApiGet } from '../../github/api-client'

export const githubCodeHostingAdapter: CodeHostingAdapter = {
  integration: 'github',
  validateRepository: (repository) => /^[\w.-]+\/[\w.-]+$/.test(repository),
  async changeRequest(reference, squadId) {
    if (!reference.changeRequest) return null
    const pr = await githubApiGet<{ merged: boolean; base: { ref: string }; head: { ref: string } }>(
      `/repos/${reference.repository}/pulls/${reference.changeRequest.number}`,
      squadId,
      reference.connectionId
    )
    return pr ? { merged: pr.merged, headBranch: pr.head.ref, baseBranch: pr.base.ref } : null
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
    const repository = integrationValueAt(metadata, 'github.repo')
    const rawNumber = integrationValueAt(metadata, 'github.issue')
    if (typeof repository !== 'string' || repository.toLowerCase() !== reference.repository.toLowerCase()) return []
    if (typeof rawNumber !== 'number' && !(typeof rawNumber === 'string' && /^[1-9][0-9]*$/.test(rawNumber))) return []
    const number = Number(rawNumber)
    if (!Number.isSafeInteger(number) || number <= 0) return []
    // Event-created streams retain their original issue connection even before a PR is attached.
    const originMatches =
      integrationValueAt(metadata, 'integrationSource.integration') === 'github' &&
      integrationValueAt(metadata, 'integrationSource.resourceKey') === `${repository.toLowerCase()}#${number}`
    const connectionId =
      integrationValueAt(metadata, 'github.connectionId') ??
      reference.connectionId ??
      (originMatches ? integrationValueAt(metadata, 'integrationSource.connectionId') : undefined)
    const identity = codeHostReferenceSchema.safeParse({ ...reference, connectionId })
    if (!identity.success) return []
    return ['assigned', 'unassigned', 'updated', 'comment'].map((event) => ({
      id: `code-host-issue-${event}`,
      source: {
        integration: 'github',
        output: `issue.${event}`,
        version: 1,
        ...(identity.data.connectionId ? { connectionId: identity.data.connectionId } : {}),
      },
      match: { repository: { value: repository.toLowerCase() }, 'issue.number': { value: number } },
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
