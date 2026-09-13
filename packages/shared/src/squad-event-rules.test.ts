import { expect, test } from 'bun:test'
import { squadMetadataSchema } from './schemas'
import {
  effectiveSquadEventRules,
  selectSquadEventRule,
  squadEventRulesSchema,
  squadEventRuleSchema,
} from './squad-event-rules'
import type { WorkflowEventTrigger } from './workflows'
import type { IntegrationOutputFact } from './integration-outputs'

const fact: IntegrationOutputFact = {
  output: 'issue.assigned',
  version: 1,
  subject: 'Assigned issue',
  body: '',
  eventKey: 'one',
  resourceKey: 'acme/repo#1',
  occurredAt: '2026-09-10T00:00:00Z',
  data: { repository: 'acme/repo', assignee: 'bot', labels: ['bug'], issue: { number: 1 } },
}
const rule = (id: string, type = 'notify-manager') =>
  squadEventRuleSchema.parse({
    id,
    source: { integration: 'github', output: fact.output, version: 1 },
    filters: { audience: 'any' },
    action: { type },
  })
test('first enabled matching rule wins, including ignore; empty config disables defaults', () => {
  const first = rule('ignored', 'ignore')
  const second = rule('manager')
  const meta = { github: [{ repo: 'acme/repo' }], integrationRules: { github: [first, second] } }
  expect(selectSquadEventRule(meta, 'github', fact, 'bot')?.action.type).toBe('ignore')
  first.enabled = false
  expect(selectSquadEventRule(meta, 'github', fact, 'bot')?.id).toBe('manager')
  expect(selectSquadEventRule({ ...meta, integrationRules: { github: [] } }, 'github', fact, 'bot')).toBeUndefined()
})
test('provider, account, repo, labels, and team filters stay scoped', () => {
  const scoped = rule('scoped')
  scoped.source.connectionId = 'a16c2a73-a1b8-4d64-bff1-87ad0905b099'
  scoped.filters = { audience: 'connected-account', squadRouting: true, repository: 'acme/*', labels: ['bug'] }
  const metadata = { github: [{ repo: 'acme/repo' }], integrationRules: { github: [scoped] } }
  const select = (input = fact, login = 'bot', account = scoped.source.connectionId) =>
    selectSquadEventRule(metadata, 'github', input, login, account)
  expect(select()?.id).toBe(scoped.id)
  expect(select(fact, 'other')).toBeUndefined()
  expect(select(fact, 'bot', 'other')).toBeUndefined()
  expect(select({ ...fact, data: { ...fact.data, repository: 'acme/other' } })).toBeUndefined()
  expect(select({ ...fact, data: { ...fact.data, labels: ['docs'] } })).toBeUndefined()
  expect(selectSquadEventRule(metadata, 'linear', fact, 'bot')).toBeUndefined()
})
test('legacy triggers are adopted with their selected workflow and metadata intact', () => {
  const trigger: WorkflowEventTrigger = {
    id: 'assigned',
    source: rule('x').source,
    match: { repository: { value: 'acme/repo' } },
    create: {
      workflow: { kind: 'preset', id: 'reviewed-coding', customizations: [] },
      titlePrefix: 'Fix: ',
      metadata: { 'github.repo': { event: 'repository' } },
    },
  }
  const rules = effectiveSquadEventRules({ integrationTriggers: [trigger] }, 'github')
  expect(rules[0]?.action).toEqual({ type: 'start-workstream', ...trigger.create })
  expect(rules[0]?.match).toEqual(trigger.match)
  expect(rules.some((rule) => rule.source.output === 'pull_request.review_requested')).toBe(true)
})
test('all four actions are shared across providers and metadata rejects invalid configurations', () => {
  for (const type of ['notify-manager', 'notify-consultant', 'start-workstream', 'ignore'] as const) {
    const item = rule('action', type)
    item.source.integration = 'linear'
    item.filters.teamId = 'team'
    const metadata = { integrationRules: { linear: [item] } }
    expect(squadMetadataSchema.safeParse(metadata).success).toBe(true)
    expect(selectSquadEventRule(metadata, 'linear', { ...fact, data: { teamId: 'team' } }, '')?.action.type).toBe(type)
    expect(selectSquadEventRule(metadata, 'linear', { ...fact, data: { teamId: 'other' } }, '')).toBeUndefined()
  }
  expect(squadEventRulesSchema.safeParse({ linear: [rule('wrong-provider')] }).success).toBe(false)
  expect(squadEventRulesSchema.safeParse({ github: [rule('duplicate'), rule('duplicate')] }).success).toBe(false)
  expect(
    squadMetadataSchema.safeParse({
      integrationRules: { github: [{ ...rule('bad'), action: { type: 'execute-shell' } }] },
    }).success
  ).toBe(false)
})

test.each(['start-workstream', 'notify-manager', 'notify-consultant'] as const)(
  'instructions for %s are optional, bounded, and retained',
  (type) => {
    const item = rule('context', type)
    const action = { type, additionalContext: '  Check accessibility.\nInclude evidence.  ' }
    expect(squadEventRuleSchema.parse({ ...item, action }).action).toMatchObject({
      additionalContext: 'Check accessibility.\nInclude evidence.',
    })
    expect(
      squadEventRuleSchema.safeParse({ ...item, action: { ...action, additionalContext: 'a'.repeat(10001) } }).success
    ).toBe(false)
  }
)
