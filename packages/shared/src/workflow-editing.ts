import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowCustomization } from './workflows'

export function createBlankWorkflow(): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'Custom workflow',
    participants: { worker: { agentTypeId: 'general', session: 'reuse-within-stream' } },
    entry: 'execute',
    routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
    limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
    steps: [
      {
        id: 'execute',
        participant: 'worker',
        instructions: 'Complete the requested deliverable.',
        output: 'Verified result.',

        outcomes: { completed: { next: 'finish' } },
      },
    ],
    completion: { mode: 'deliverable' },
  })
}

/** Compare against the inspected revision, not a newer query result while the user edits. */
export function workflowRevisionOperations(
  base: WorkflowDefinition,
  definition: WorkflowDefinition
): WorkflowCustomization[] {
  workflowDefinitionSchema.parse(definition)
  return [
    ...Object.entries(definition.participants).map(([id, participant]) => ({
      op: 'put-participant' as const,
      id,
      participant,
    })),
    ...definition.steps.map((step) => ({ op: 'put-step' as const, step })),
    ...base.steps
      .filter((step) => !definition.steps.some((entry) => entry.id === step.id))
      .map((step) => ({ op: 'remove-step' as const, id: step.id })),
    ...Object.keys(base.participants)
      .filter((id) => !definition.participants[id])
      .map((id) => ({ op: 'remove-participant' as const, id })),
    { op: 'set-name', name: definition.name },
    { op: 'set-step-order', ids: definition.steps.map((step) => step.id) },
    { op: 'set-entry', entry: definition.entry },
    { op: 'set-routing', routing: definition.routing },
    { op: 'set-limits', limits: definition.limits },
    { op: 'set-completion', completion: definition.completion },
    ...(base.subscriptions || definition.subscriptions
      ? [{ op: 'set-subscriptions' as const, subscriptions: definition.subscriptions ?? [] }]
      : []),
  ]
}
