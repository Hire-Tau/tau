import { linearOutputCatalog } from '@tau/shared'
import { createHash } from 'node:crypto'
import type { IntegrationOutputAdapter } from '../outputs/types'

export const linearOutputAdapter: IntegrationOutputAdapter = {
  integration: 'linear',
  catalog: linearOutputCatalog,
  workStreamBindings() {
    return { 'linear.issueId': { event: 'issue.id' }, 'linear.teamId': { event: 'teamId' } }
  },
  normalize(event) {
    const payload = event.payload as {
      action?: string
      updatedFrom?: { assigneeId?: unknown }
      webhookTimestamp?: number
      data?: {
        id?: string
        title?: string
        teamId?: string
        assigneeId?: string
        url?: string
        description?: string
        updatedAt?: string
      }
    }
    const issue = payload?.data
    if (
      event.type !== 'Issue' ||
      payload.action !== 'update' ||
      !payload.updatedFrom ||
      !('assigneeId' in payload.updatedFrom) ||
      !issue?.id ||
      !issue.assigneeId ||
      !issue.teamId
    )
      return []
    const at = issue.updatedAt ?? (payload.webhookTimestamp ? new Date(payload.webhookTimestamp).toISOString() : '')
    if (!Number.isFinite(Date.parse(at))) return []
    return [
      {
        output: 'issue.assigned',
        version: 1,
        resourceKey: issue.id,
        occurredAt: at,
        eventKey: createHash('sha256')
          .update(JSON.stringify([issue.id, issue.assigneeId, at]))
          .digest('hex'),
        data: {
          issue: { id: issue.id, title: (issue.title ?? '').slice(0, 500) },
          teamId: issue.teamId,
          assignee: issue.assigneeId,
        },
        subject: `Linear issue assigned: ${(issue.title ?? issue.id).slice(0, 500)}`,
        body: `${issue.url ?? ''}\n\n${issue.description ?? ''}`.slice(0, 30000),
        ...(issue.url ? { url: issue.url } : {}),
      },
    ]
  },
}
