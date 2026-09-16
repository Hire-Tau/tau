import type { IntegrationOutputDescriptor, IntegrationOutputField } from './integration-outputs'

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

export type EventPredicateField = Omit<IntegrationOutputField, 'type'> & {
  type: IntegrationOutputField['type'] | 'string[]'
}
const collectionFields: Record<string, EventPredicateField> = {
  labels: { type: 'string[]', description: 'Issue or pull request labels (case-sensitive).' },
  assignees: { type: 'string[]', normalize: 'lowercase', description: 'Assigned GitHub logins.' },
  actorType: { type: 'string', description: 'Actor account type, e.g. User or Bot.' },
  mergeConflict: { type: 'boolean', description: 'True when GitHub reports a merge conflict; otherwise absent.' },
  path: { type: 'string', description: 'Reviewed file path.' },
  line: { type: 'number', description: 'Reviewed line; absent or null for an outdated comment.' },
}
function githubPredicateFields(output: string): Record<string, EventPredicateField> {
  const paths = ['repository', 'action', 'actor', 'actorType']
  if (output.startsWith('issue.')) paths.push('issue.number', 'issue.title')
  else paths.push('pullRequest.number', 'pullRequest.headSha')
  if (output !== 'pull_request.ci_completed') paths.push('labels', 'assignees')
  if (['issue.assigned', 'issue.unassigned'].includes(output)) paths.push('assignee')
  if (output === 'pull_request.review_requested') paths.push('requestedReviewer', 'requestedTeam')
  if (output === 'pull_request.reviewed' || output === 'pull_request.ci_completed') paths.push('state')
  if (output === 'pull_request.ci_completed') paths.push('workflow')
  if (output === 'pull_request.updated') paths.push('mergeConflict')
  if (output === 'pull_request.review_comment') paths.push('path', 'line')
  return Object.fromEntries(paths.map((path) => [path, fields[path] ?? collectionFields[path]!]))
}

/** Subscription fields remain backward compatible; predicates use a narrower event-specific allowlist. */
export const githubOutputCatalog: IntegrationOutputDescriptor[] = Object.entries(outputs).map(([output, title]) => ({
  integration: 'github',
  output,
  version: 1,
  title,
  description: title + ' from GitHub webhooks or polling.',
  fields,
  predicateFields: githubPredicateFields(output),
}))
const linearFields: Record<string, IntegrationOutputField> = {
  'issue.id': { type: 'string', description: 'Linear issue ID.' },
  'issue.number': { type: 'number', description: 'Linear issue number, scoped to its team.' },
  'issue.identifier': { type: 'string', description: 'Linear issue identifier, e.g. ENG-123.' },
  'issue.title': { type: 'string', description: 'Issue title.' },
  teamId: { type: 'string', description: 'Linear team ID.' },
  teamKey: { type: 'string', normalize: 'lowercase', description: 'Linear team key, e.g. ENG.' },
  assignee: { type: 'string', description: 'Assigned Linear user ID.' },
  action: { type: 'string', description: 'Native Linear event action.' },
  actor: { type: 'string', description: 'Acting Linear user ID.' },
  state: { type: 'string', description: 'Linear workflow state type (e.g. completed, canceled, started).' },
}
const linearPredicateFields: Record<string, EventPredicateField> = {
  ...linearFields,
  labels: { type: 'string[]', description: 'Issue labels.' },
}
const linearOutputs: Record<string, string> = {
  'issue.assigned': 'Issue assigned',
  'issue.unassigned': 'Issue unassigned',
  'issue.updated': 'Issue updated',
  'issue.comment': 'Issue comment',
}
export const linearOutputCatalog: IntegrationOutputDescriptor[] = Object.entries(linearOutputs).map(
  ([output, title]) => ({
    integration: 'linear',
    output,
    version: 1,
    title,
    // Linear has no polling path: a missed or failed webhook delivery is not recovered.
    description: title + ' from Linear webhooks.',
    fields: linearFields,
    predicateFields: linearPredicateFields,
  })
)
export function eventPredicateFields(source: { integration: string; output: string; version: number }) {
  return [...githubOutputCatalog, ...linearOutputCatalog].find(
    (event) =>
      event.integration === source.integration && event.output === source.output && event.version === source.version
  )?.predicateFields
}

/** Only own allowlist entries count; Object.prototype names are never event fields. */
export function eventPredicateField(source: { integration: string; output: string; version: number }, path: string) {
  const fields = eventPredicateFields(source)
  return fields && Object.hasOwn(fields, path) ? fields[path] : undefined
}
