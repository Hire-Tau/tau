import { createHash } from 'node:crypto'
import type { IntegrationOutputDescriptor, IntegrationOutputFact } from '@tau/shared'
import type { IntegrationOutputAdapter } from './types'

const fields: IntegrationOutputDescriptor['fields'] = {
  repository: { type: 'string', normalize: 'lowercase', description: 'Repository owner/name.' },
  'pullRequest.number': { type: 'number', description: 'Pull request number.' },
  'pullRequest.headSha': { type: 'string', description: 'Pull request head commit, when supplied.' },
  'issue.number': { type: 'number', description: 'Issue number.' },
  'issue.title': { type: 'string', description: 'Issue title.' },
  assignee: { type: 'string', normalize: 'lowercase', description: 'Assigned or unassigned GitHub login.' },
  action: { type: 'string', description: 'Native event action.' },
  actor: { type: 'string', normalize: 'lowercase', description: 'Actor login.' },
  state: { type: 'string', description: 'Review state or CI conclusion.' },
  requestedReviewer: { type: 'string', normalize: 'lowercase', description: 'Requested reviewer login.' },
  requestedTeam: { type: 'string', description: 'Requested reviewer team.' },
  workflow: { type: 'string', description: 'CI workflow name.' },
}
const outputs = {
  'issue.assigned': 'Issue assigned',
  'issue.unassigned': 'Issue unassigned',
  'issue.updated': 'Issue updated',
  'issue.comment': 'Issue comment',
  'pull_request.updated': 'Pull request updated',
  'pull_request.merged': 'Pull request merged',
  'pull_request.closed': 'Pull request closed',
  'pull_request.review_requested': 'Review requested',
  'pull_request.reviewed': 'Review submitted',
  'pull_request.comment': 'Pull request comment',
  'pull_request.review_comment': 'Review line comment',
  'pull_request.ci_completed': 'CI completed',
}
function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The adapter describes GitHub facts. It knows nothing about Tau agents or flow routing. */
export const githubOutputAdapter: IntegrationOutputAdapter = {
  integration: 'github',
  catalog: Object.entries(outputs).map(([output, title]) => ({
    integration: 'github',
    output,
    version: 1,
    title,
    description: title + ' from GitHub webhooks or polling.',
    fields,
  })),
  workStreamBindings(fact) {
    return {
      'github.repo': { event: 'repository' },
      ...(fact.data.pullRequest
        ? { 'github.pr.number': { event: 'pullRequest.number' } }
        : { 'github.issue': { event: 'issue.number' } }),
    }
  },
  normalize(event) {
    const payload = record(event.payload)
    const repository = payload?.repository?.full_name
    if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) return []
    const repo = repository.toLowerCase()
    const native = record(payload!.pull_request) ?? record(payload!.issue)
    const nestedRepo = native?.base?.repo?.full_name
    if (nestedRepo && (typeof nestedRepo !== 'string' || nestedRepo.toLowerCase() !== repo)) return []
    if (payload!.number !== undefined && native?.number !== undefined && payload!.number !== native.number) return []
    const action = typeof payload!.action === 'string' ? payload!.action : ''
    let output: keyof typeof outputs
    let item = native
    let numbers = [native?.number]
    if (event.type === 'workflow_run') {
      item = record(payload!.workflow_run)
      if (!item || action !== 'completed') return []
      if (typeof item.conclusion !== 'string' || !/^[a-z0-9_-]+$/.test(item.conclusion)) return []
      output = 'pull_request.ci_completed'
      numbers = Array.isArray(item.pull_requests)
        ? item.pull_requests
            .filter(
              (pr: any) =>
                pr &&
                (!pr.base?.repo?.full_name ||
                  (typeof pr.base.repo.full_name === 'string' && pr.base.repo.full_name.toLowerCase() === repo))
            )
            .map((pr: any) => pr.number)
        : []
    } else if (event.type === 'issues' && native && !native.pull_request) {
      output = action === 'assigned' ? 'issue.assigned' : action === 'unassigned' ? 'issue.unassigned' : 'issue.updated'
    } else if (event.type === 'pull_request') {
      if (!native) return []
      output =
        action === 'review_requested'
          ? 'pull_request.review_requested'
          : action === 'closed'
            ? native.merged
              ? 'pull_request.merged'
              : 'pull_request.closed'
            : 'pull_request.updated'
    } else if (event.type === 'pull_request_review') {
      if (action !== 'submitted') return []
      output = 'pull_request.reviewed'
      item = record(payload!.review)
    } else if (event.type === 'pull_request_review_comment') {
      if (!['created', 'edited'].includes(action)) return []
      output = 'pull_request.review_comment'
      item = record(payload!.comment)
    } else if (event.type === 'issue_comment' && native) {
      if (!['created', 'edited'].includes(action)) return []
      output = native.pull_request ? 'pull_request.comment' : 'issue.comment'
      item = record(payload!.comment)
    } else return []
    if (!item) return []
    const timestamp =
      (output === 'pull_request.reviewed'
        ? item.submitted_at
        : output === 'pull_request.merged'
          ? native?.merged_at
          : output === 'pull_request.closed'
            ? native?.closed_at
            : undefined) ??
      item.updated_at ??
      item.submitted_at ??
      item.completed_at ??
      item.created_at
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return []
    const actor = payload!.sender?.login ?? item.user?.login ?? ''
    const url =
      typeof item.html_url === 'string' && item.html_url.startsWith('https://github.com/') ? item.html_url : undefined
    const body = typeof item.body === 'string' ? item.body.slice(0, 24000) : ''
    return [...new Set(numbers)].flatMap((number): IntegrationOutputFact[] => {
      if (!Number.isSafeInteger(number) || number <= 0) return []
      const data = {
        repository: repo,
        ...(output.startsWith('issue.')
          ? { issue: { number, title: String(native?.title ?? '') } }
          : {
              pullRequest: {
                number,
                ...(typeof (native?.head?.sha ?? item!.head_sha) === 'string'
                  ? { headSha: native?.head?.sha ?? item!.head_sha }
                  : {}),
              },
            }),
        assignee: String(payload!.assignee?.login ?? ''),
        action,
        actor: String(actor),
        state: String(item!.conclusion ?? item!.state ?? ''),
        requestedReviewer: String(payload!.requested_reviewer?.login ?? ''),
        requestedTeam: String(payload!.requested_team?.slug ?? ''),
        actorType: String(payload!.sender?.type ?? item!.user?.type ?? ''),
        labels: Array.isArray(native?.labels)
          ? native.labels.map((label: any) => String(label?.name ?? label)).slice(0, 100)
          : [],
        assignees: Array.isArray(native?.assignees)
          ? native.assignees.map((user: any) => String(user?.login ?? '')).slice(0, 100)
          : [],
        ...(output === 'pull_request.ci_completed'
          ? {
              ci: {
                workflowId: String(item!.workflow_id ?? ''),
                runId: String(item!.id ?? ''),
                runNumber: String(item!.run_number ?? ''),
                runAttempt: String(item!.run_attempt ?? ''),
              },
            }
          : {}),
        ...(output === 'pull_request.review_comment'
          ? { path: String(item!.path ?? ''), line: item!.line ?? item!.original_line ?? null }
          : {}),
        ...(native?.mergeable_state === 'dirty' ? { mergeConflict: true } : {}),
        workflow: String(item!.name ?? ''),
      }
      const ordering =
        output === 'pull_request.ci_completed' &&
        Number.isSafeInteger(item!.run_number) &&
        Number.isSafeInteger(item!.run_attempt)
          ? { key: String(item!.workflow_id ?? item!.name), position: [item!.run_number, item!.run_attempt] }
          : undefined
      return [
        {
          output,
          version: 1,
          resourceKey: `${repo}#${number}`,
          occurredAt: new Date(timestamp).toISOString(),
          eventKey: digest([
            output,
            repo,
            number,
            action,
            item!.id,
            output === 'pull_request.updated' && action === 'synchronize'
              ? (native?.head?.sha ?? timestamp)
              : timestamp,
            data.state,
            data.requestedReviewer,
            data.assignee,
            ordering,
            ...(data.requestedTeam ? [data.requestedTeam] : []),
          ]),
          data,
          subject: `${outputs[output]}: ${repo}#${number}`,
          body: `${outputs[output]}${actor ? ` by ${actor}` : ''}${data.state ? ` (${data.state})` : ''}.${data.mergeConflict ? '\nMerge conflicts need resolution.' : ''}${output === 'pull_request.review_comment' ? `\n${data.path}:${data.line ?? '?'} — reply in this review thread.` : ''}${url ? `\n${url}` : ''}${body ? `\n\n${body}` : ''}`,
          ...(url ? { url } : {}),
          ...(ordering ? { ordering } : {}),
        },
      ]
    })
  },
}
