import { activeWorkflowAttempts, type WorkflowAttempt, type WorkflowRun } from '@tau/shared'
import { flowCapabilityInstructions } from './capability-instructions'

type HandoffStream = {
  id: string
  title: string
  description: string
  handoffMessage?: string | null
  metadata: unknown
}

/** Preserve requirements and evidence verbatim; keep shared operating rules out of each assignment. */
export function flowMessage(
  stream: HandoffStream,
  run: { state: WorkflowRun; version: number },
  attempt: WorkflowAttempt
) {
  const step = attempt.step ?? run.state.definition.steps.find((entry) => entry.id === attempt.stepId)!
  const metadata = stream.metadata as { git?: Record<string, unknown>; codeHost?: Record<string, unknown> } | null
  const workspace = [
    ['Worktree', metadata?.git?.worktree],
    ['Branch', metadata?.git?.branch],
    ['Base', metadata?.git?.baseBranch],
    ['Repository', metadata?.codeHost?.repository ?? metadata?.git?.repository],
  ].filter(([, value]) => typeof value === 'string' && value.length)
  // Runtime provenance follows the actual handoff, not every possible graph edge or prior result.
  const sources = new Set(attempt.sourceAttemptIds ?? [])
  const results = run.state.attempts
    .filter((entry) => sources.has(entry.id) && (entry.evidence || entry.feedback))
    .map((entry) => `${entry.stepId} (attempt ${entry.id}): ${entry.evidence ?? entry.feedback}`)
  const returns = run.state.returns.filter(
    (entry) =>
      entry.status === 'open' &&
      entry.branch?.forkId === attempt.branch?.forkId &&
      entry.branch?.branchId === attempt.branch?.branchId
  )
  const example = {
    expectedVersion: run.version,
    attemptId: attempt.id,
    action: 'complete',
    outcome: Object.keys(step.outcomes)[0],
    evidence: 'Describe the result, checks performed, and relevant paths or links.',
  }
  return [
    `Work stream ${stream.id}: ${stream.title}\nStep: ${step.id} (attempt ${attempt.id}, version ${run.version})`,
    `${step.instructions}\nExpected output: ${step.output}`,
    workspace.length ? workspace.map(([label, value]) => `${label}: ${value}`).join('\n') : '',
    results.length ? `Incoming results:\n\n${results.join('\n\n')}` : '',
    `History: tau workstream flow ${stream.id} returns state.attempts (evidence, feedback, sourceAttemptIds) and state.returns (rework requests). Query it when you need earlier results or handoff context.`,
    attempt.sourceAttemptIds === undefined
      ? 'This older attempt has no recorded handoff sources; consult the run history for its incoming context.'
      : '',
    returns.length
      ? `Open return requests:\n${returns.map((entry) => `${entry.targetStepId} → ${entry.resumeAt}: ${entry.feedback}`).join('\n')}`
      : '',
    stream.description
      ? `Original work brief (initial context; use incoming results for progress):\n${stream.description}`
      : '',
    stream.handoffMessage ? `Owner's handoff:\n${stream.handoffMessage}` : '',
    flowCapabilityInstructions(run.state, attempt, run.version),
    attempt.branch || activeWorkflowAttempts(run.state).length > 1
      ? 'Parallel agents share this workspace. Coordinate file ownership; use a stream-scoped blocker only for an issue affecting everyone.'
      : '',
    `Submit with tau workstream advance ${stream.id} --file COMMAND.json. Choose the appropriate outcome above and replace the evidence string:\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\``,
    `After submitting, end your turn if workStreamStatus is done. Otherwise follow deliveryInstructions when present; if another step is active, end your turn. Read tau workstream flow ${stream.id} for current state or after a version conflict. Retry only if this attempt is still running.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
