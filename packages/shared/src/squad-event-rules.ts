import { z } from 'zod'
import { integrationSubscriptionSchema, integrationValueAt, type IntegrationOutputFact } from './integration-outputs'
import { workflowEventTriggerSchema, workflowSourceSchema, type WorkflowSource } from './workflows'

export const squadEventRuleSchema = z
  .object({
    id: workflowEventTriggerSchema.shape.id,
    enabled: z.boolean().default(true),
    source: integrationSubscriptionSchema.shape.source,
    match: workflowEventTriggerSchema.shape.match.optional(),
    filters: z
      .object({
        squadRouting: z.boolean().default(false),
        repository: z.string().trim().max(200).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        teamId: z.string().trim().max(200).optional(),
        audience: z.enum(['connected-account', 'assigned-or-mentioned', 'any']).default('connected-account'),
      })
      .strict(),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('notify-manager') }).strict(),
      z.object({ type: z.literal('notify-consultant') }).strict(),
      z.object({ type: z.literal('ignore') }).strict(),
      z
        .object({
          type: z.literal('start-workstream'),
          workflow: workflowSourceSchema.optional(),
          titlePrefix: z.string().max(100).optional(),
          additionalContext: z.string().trim().max(10000).optional(),
          metadata: workflowEventTriggerSchema.shape.create.shape.metadata.optional(),
        })
        .strict(),
    ]),
  })
  .strict()
export type SquadEventRule = z.infer<typeof squadEventRuleSchema>
export const squadEventRulesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    z
      .array(squadEventRuleSchema)
      .max(32)
      .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Duplicate event rule ID')
  )
  .superRefine((providers, ctx) => {
    for (const [provider, rules] of Object.entries(providers))
      rules.forEach((rule, index) => {
        if (rule.source.integration !== provider)
          ctx.addIssue({
            code: 'custom',
            path: [provider, index, 'source'],
            message: 'Rule provider must match its integration',
          })
      })
  })
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : []
export function eventRepositoryMatches(pattern: string, repository: string) {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i'
  ).test(repository)
}
export function matchesGitHubRouting(metadata: unknown, repository: unknown, labels?: unknown): boolean {
  return (
    typeof repository === 'string' &&
    Array.isArray(record(metadata).github) &&
    record(metadata).github.some(
      (route: any) =>
        typeof route?.repo === 'string' &&
        eventRepositoryMatches(route.repo, repository) &&
        (labels === undefined ||
          !strings(route.labels).length ||
          strings(route.labels).some((label) => strings(labels).includes(label)))
    )
  )
}

/** Missing config adopts the old behavior as visible editable rules. An explicit [] disables it. */
export function effectiveSquadEventRules(metadata: unknown, provider: string): SquadEventRule[] {
  const stored = record(metadata)
  if (Object.prototype.hasOwnProperty.call(record(stored.integrationRules), provider))
    return squadEventRulesSchema.parse({ [provider]: stored.integrationRules[provider] })[provider]!
  const existing: SquadEventRule[] = Array.isArray(stored.integrationTriggers)
    ? stored.integrationTriggers
        .map((value: unknown) => workflowEventTriggerSchema.parse(value))
        .filter((trigger: any) => trigger.source.integration === provider)
        .map((trigger: any) => ({
          id: trigger.id,
          enabled: true,
          source: trigger.source,
          match: trigger.match,
          filters: { squadRouting: false, audience: 'any' },
          action: { type: 'start-workstream', ...trigger.create },
        }))
    : []
  const defaults =
    provider === 'github'
      ? [
          ['issue.assigned', 'notify-manager', 'connected-account'],
          ['issue.unassigned', 'notify-manager', 'connected-account'],
          ['pull_request.review_requested', 'start-workstream', 'connected-account'],
          ...['issue.comment', 'pull_request.comment', 'pull_request.reviewed', 'pull_request.review_comment'].map(
            (output) => [output, 'notify-manager', 'assigned-or-mentioned']
          ),
        ]
      : provider === 'linear'
        ? [['issue.assigned', 'notify-manager', 'connected-account']]
        : []
  for (const [output, action, audience] of defaults) {
    const id = `${provider}-${output!.replaceAll('_', '-').replaceAll('.', '-')}`
    if (!existing.some((rule) => rule.id === id))
      existing.push(
        squadEventRuleSchema.parse({
          id,
          enabled: true,
          source: { integration: provider, output, version: 1 },
          filters: { squadRouting: true, audience },
          action: { type: action },
        })
      )
  }
  return existing
}

export function selectSquadEventRule(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string
) {
  const data = record(fact.data)
  return effectiveSquadEventRules(metadata, integration).find((rule) => {
    if (
      !rule.enabled ||
      rule.source.output !== fact.output ||
      rule.source.version !== fact.version ||
      (rule.source.connectionId && rule.source.connectionId !== connectionId)
    )
      return false
    const filters = rule.filters
    if (filters.squadRouting) {
      if (
        integration === 'github' &&
        !matchesGitHubRouting(
          metadata,
          data.repository,
          fact.output.startsWith('issue.') && fact.output !== 'issue.comment' ? data.labels : undefined
        )
      )
        return false
      if (integration === 'linear') {
        const routes = record(metadata).linear
        if (
          typeof data.teamId !== 'string' ||
          !(Array.isArray(routes) ? routes : [routes]).some((route) => route?.teamId === data.teamId)
        )
          return false
      }
    }
    if (filters.repository && !eventRepositoryMatches(filters.repository, String(data.repository ?? ''))) return false
    if (filters.labels?.length && !filters.labels.some((label) => strings(data.labels).includes(label))) return false
    if (filters.teamId && filters.teamId !== data.teamId) return false
    if (
      rule.match &&
      !Object.entries(rule.match).every(([path, binding]) => {
        const actual = integrationValueAt(fact.data, path)
        return typeof actual === 'string' && ['repository', 'assignee', 'actor', 'requestedReviewer'].includes(path)
          ? actual.toLowerCase() === String(binding.value).toLowerCase()
          : actual === binding.value
      })
    )
      return false
    if (integration !== 'github' || filters.audience === 'any') return true
    if (!login) return false
    if (filters.audience === 'connected-account') {
      if (fact.output === 'pull_request.review_requested')
        return !!data.requestedTeam || String(data.requestedReviewer).toLowerCase() === login.toLowerCase()
      if (['issue.assigned', 'issue.unassigned'].includes(fact.output))
        return String(data.assignee).toLowerCase() === login.toLowerCase()
    }
    if (String(data.actor).toLowerCase() === login.toLowerCase() || data.actorType === 'Bot') return false
    const mention = new RegExp(
      `(^|[^a-zA-Z0-9_])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`,
      'i'
    )
    return (
      strings(data.assignees).some((assignee) => assignee.toLowerCase() === login.toLowerCase()) ||
      mention.test(fact.body)
    )
  })
}

export function eventRuleWorkflow(rule: SquadEventRule, metadata: unknown): WorkflowSource {
  return (
    (rule.action.type === 'start-workstream' && rule.action.workflow) ||
    record(metadata).workflow || { kind: 'preset', id: 'solo', customizations: [] }
  )
}
