import type { WorkflowDefinition, WorkflowRun } from '@tau/shared'

/** Delivery guidance is shared by every flow participant, independent of squad or agent type. */
export function flowCompletionInstructions(mode: WorkflowDefinition['completion']['mode']): string {
  const guidance = {
    deliverable:
      'Deliver the requested result with verification evidence. No PR, repository mutation, or additional reviewer is required by this completion mode.',
    'review-approval':
      'Present the completed result and evidence to the human for delivery approval. A human must invoke flow finish; a participant cannot approve delivery on their behalf.',
    'pr-merge':
      'Prepare and push the configured branch and create or reuse its PR. Leave merging to the human; do not merge it yourself. Wait until the configured code hosting integration confirms that the PR is merged before finishing the flow.',
    'pr-auto-merge':
      'Prepare and push the configured branch and create or reuse its PR. Read the current squad metadata.policies.allowAutoMerge before enabling the provider’s native auto-merge. It must be explicitly true; a missing flag means permission is not granted. Do not enable that policy yourself. If permission is absent or the provider rejects auto-merge, leave the PR open for a human merge and explain the fallback to the owner. Never use --admin or bypass required checks and approvals. Enabling auto-merge is not completion: wait until the configured code hosting integration confirms the PR is merged before finishing the flow.',
    'direct-merge':
      'Read the current squad metadata.policies.allowDirectMerge before merging or pushing to the base branch. It must be explicitly true; a missing flag means permission is not granted. Do not enable that policy yourself. If permission is absent, ask the owner to authorize a revision to pr-merge; do not silently change the flow or merge directly. If allowed, integrate the configured work-stream commit using a clean base checkout or integration worktree, preserving other work, and push the base branch. Record codeHost.integration, codeHost.repository, git.baseBranch, and git.commit (the full deliverable SHA). Flow finish verifies that the commit is included in the remote base branch.',
  } satisfies Record<WorkflowDefinition['completion']['mode'], string>

  const pr = mode === 'pr-merge' || mode === 'pr-auto-merge'
  return [
    `Delivery policy: ${mode}. The workflow determines responsibility for delivery; no agent role intrinsically owns PR creation or completion.`,
    guidance[mode],
    'If CI fails, review feedback requests changes, or merge conflicts require edits after completion-ready, verify the findings still apply to the current PR head. Before editing, read tau workstream flow and submit tau workstream advance STREAM_ID --content \'{"action":"rework","expectedVersion":VERSION,"attemptId":DELIVERY_AGENT_ATTEMPT_ID,"feedback":"Current findings and required corrections"}\'. Replace the numeric placeholders with inspected values; use --stdin with a quoted heredoc for longer JSON/YAML feedback instead of creating a temporary file. The delivery participant or flow manager can request it. Use the latest completed attempt of completion.changeEventsTo.step when configured, otherwise the last completed agent attempt. Rework creates a tracked attempt at that delivery step (or its outer parallel fork); use its normal outcomes to route corrections and repeat review. Final delivery approval may be sent back for this rework and will be required again afterward; it does not block triaging code-host feedback. Preserve pauses, intermediate human-approval steps, and unrelated waits. Duplicate/stale events need no rework. Do not recreate the stream or edit without an active attempt.',
    pr
      ? 'Use the work stream’s existing codeHost binding. After creating or locating its PR, attach codeHost.changeRequest.number and codeHost.changeRequest.url for event routing. If the binding is missing, identify the repository and squad-authorized integration first. Check live PR mergeability after creation, CI, and approval. Resolve conflicts through an authorized flow return or revision and re-review the affected changes. Do not use a legacy completing review wait to finish a flow.'
      : '',
    'Once all required steps and return obligations are satisfied, re-read tau workstream flow. At completion-ready, carry out the delivery policy and use tau workstream finish with the current --version when its condition is met. Bare status updates and legacy approve commands cannot finish a flow. If delivery is waiting on an external event or human, tell the owner what remains and end the turn without polling or spawning another agent.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Only current, active delivery work needs the provider/delivery procedure. */
export function deliveryInstructionsForRun(
  stream: { id: string; status: string; pause?: unknown },
  state: WorkflowRun,
  version: number
): string | undefined {
  if (stream.status !== 'active' || stream.pause || state.status !== 'completion-ready') return undefined
  return `${flowCompletionInstructions(state.definition.completion.mode)}\n\nWhen the condition is met: tau workstream finish ${stream.id} --version ${version}.`
}
