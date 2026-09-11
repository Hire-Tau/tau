import { expect, test } from 'bun:test'
import {
  integrationSubscriptionSchema,
  integrationSubscriptionMatches,
  integrationValueAt,
  type IntegrationOutputDescriptor,
  type IntegrationOutputFact,
} from './integration-outputs'
import { createBlankWorkflow, workflowRevisionOperations } from './workflow-editing'
import { resolveWorkflow, workflowDefinitionSchema } from './workflows'

const descriptor: IntegrationOutputDescriptor = {
  integration: 'documents',
  output: 'document.updated',
  version: 1,
  title: 'Document updated',
  description: 'Document changes',
  fields: {
    workspace: { type: 'string', normalize: 'lowercase', description: 'Workspace' },
    revision: { type: 'number', description: 'Revision' },
  },
}
const subscription = integrationSubscriptionSchema.parse({
  id: 'document',
  source: { integration: 'documents', output: 'document.updated', version: 1 },
  match: { workspace: { streamMetadata: 'document.workspace' }, revision: { value: 2 } },
  deliver: { to: 'active' },
})
const fact: IntegrationOutputFact = {
  output: 'document.updated',
  version: 1,
  eventKey: 'change-1',
  resourceKey: 'document-1',
  occurredAt: '2026-09-07T10:00:00Z',
  subject: 'Updated',
  body: 'Content changed',
  data: { workspace: 'ACME', revision: 2 },
}

test('non-GitHub outputs match typed fields and explicit normalization', () => {
  expect(integrationSubscriptionMatches(subscription, fact, { document: { workspace: 'acme' } }, descriptor)).toBe(true)
  expect(integrationSubscriptionMatches(subscription, fact, {}, descriptor)).toBe(false)
  expect(
    integrationSubscriptionMatches(
      subscription,
      { ...fact, data: { workspace: 'acme', revision: '2' } },
      { document: { workspace: 'acme' } },
      descriptor
    )
  ).toBe(false)
})
test('match paths cannot read inherited properties or prototypes', () => {
  expect(integrationValueAt({}, 'constructor.name')).toBeUndefined()
  expect(
    integrationSubscriptionSchema.safeParse({ ...subscription, match: { 'constructor.name': { value: 'Object' } } })
      .success
  ).toBe(false)
})
test('subscriptions survive preset customization and live revision without a parallel graph config', () => {
  const base = createBlankWorkflow()
  const definition = { ...base, subscriptions: [subscription] }
  const resolved = resolveWorkflow(
    { kind: 'preset', id: 'solo', customizations: workflowRevisionOperations(base, definition) },
    { id: 'solo', revision: '1', definition: base, disabled: false }
  )
  expect(resolved.definition.subscriptions).toEqual([subscription])
  expect(
    workflowDefinitionSchema.safeParse({ ...definition, subscriptions: [subscription, subscription] }).success
  ).toBe(false)
  expect(
    workflowDefinitionSchema.safeParse({
      ...definition,
      subscriptions: [{ ...subscription, deliver: { to: { participant: 'missing' }, whenInactive: 'retain' } }],
    }).success
  ).toBe(false)
})
