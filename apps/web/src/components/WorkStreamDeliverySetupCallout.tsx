import { changeRequestBindCommand, type WorkStream, type WorkStreamPresentationFacts } from '@tau/shared'
import { getWsDisplayState } from '../lib/workStreamStatusPresentation'
import { Badge } from './Badge'

/** What each PR-delivery completion mode needs before the stream can complete. */
const MODE_REQUIREMENTS: Partial<Record<WorkStream['completionMode'], string>> = {
  'pr-merge': 'its delivery pull request must be merged before this stream can complete',
  'pr-auto-merge': 'its delivery pull request must be merged (auto-merge enabled) before this stream can complete',
  'direct-merge': 'its deliverable commit must be merged into the base branch before this stream can complete',
}

type SetupStream = Pick<WorkStream, 'id' | 'number' | 'completionMode' | 'metadata'> & WorkStreamPresentationFacts

/**
 * Explains, in plain language, why a delivery-setup stream cannot complete:
 * the deliverable's concrete blocker plus the next human step when the
 * server's delivery facts carry one. Rendered only in the delivery_setup
 * presentation state.
 */
export function WorkStreamDeliverySetupCallout({ stream }: { stream: SetupStream }) {
  if (getWsDisplayState(stream) !== 'delivery_setup') return null
  const explanation = stream.delivery?.explanation
  const setupReason = explanation?.setupReason
  const gates = explanation?.gates
  const requirement = MODE_REQUIREMENTS[stream.completionMode]

  const blocker =
    setupReason === 'unbound'
      ? "No delivery pull request is bound to this work stream, so the platform can't track or verify its merge."
      : setupReason === 'not-following-changes'
        ? "This flow's completion policy isn't set to follow code-host changes, so the pull request's merge can't be tracked automatically."
        : setupReason === 'branch-mismatch'
          ? "The tracked pull request doesn't match this work stream's branches."
          : setupReason === 'direct-merge-facts'
            ? 'Direct-merge delivery needs a code-host binding plus the full commit SHA and base branch in this stream\u2019s git metadata.'
            : null

  const mismatchLines =
    setupReason === 'branch-mismatch' && explanation?.branchMismatch
      ? [
          ...(explanation.branchMismatch.streamBranch && explanation.branchMismatch.pullRequestBranch
            ? [
                `Stream branch ${explanation.branchMismatch.streamBranch} — pull request head branch ${explanation.branchMismatch.pullRequestBranch}`,
              ]
            : []),
          ...(explanation.branchMismatch.streamBaseBranch && explanation.branchMismatch.pullRequestBaseBranch
            ? [
                `Stream base branch ${explanation.branchMismatch.streamBaseBranch} — pull request base branch ${explanation.branchMismatch.pullRequestBaseBranch}`,
              ]
            : []),
        ]
      : []

  const gateLines = gates
    ? [
        ...(gates.mergeState === 'blocked'
          ? [
              'GitHub reports the merge as blocked by branch protection — commonly a required commit signature the head commit does not carry.',
            ]
          : []),
        ...(gates.checksState === 'failure' ? ["Checks are failing on the pull request's head commit."] : []),
        ...(gates.checksState === 'pending' ? ["Checks are still running on the pull request's head commit."] : []),
        ...(gates.reviewDecision === 'required' || gates.pendingHumanReview === true
          ? ['A required review is still missing.']
          : []),
        ...(gates.draft === true ? ['The pull request is still a draft.'] : []),
      ]
    : []

  const blockedByProtection = gates?.mergeState === 'blocked'
  const bindCommand =
    setupReason === 'unbound' || setupReason === 'branch-mismatch'
      ? changeRequestBindCommand(String(stream.number ?? stream.id), stream.metadata)
      : null

  const nextStep = blockedByProtection
    ? 'Add an SSH key as a Signing Key at github.com/settings/keys and push a signed head commit, or merge the pull request via the GitHub UI if your policy allows it.'
    : setupReason === 'unbound'
      ? 'Bind the delivery pull request to this work stream:'
      : setupReason === 'branch-mismatch'
        ? "Rebind the pull request that carries this work stream's branch, or merge the intended one via the GitHub UI:"
        : setupReason === 'not-following-changes'
          ? 'Merge the pull request via the GitHub UI, then finish delivery from this work stream.'
          : setupReason === 'direct-merge-facts'
            ? 'Record the deliverable commit (git.commit) and base branch (git.baseBranch) with a code-host binding on this work stream.'
            : 'Check the delivery requirements on the linked pull request, then finish delivery from this work stream.'

  return (
    <section aria-label="Delivery setup explanation" className="p-4 rounded-xl bg-surface-secondary space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <Badge color="danger">Delivery setup</Badge>
        <h3 className="text-sm font-medium text-primary">What is blocking completion</h3>
      </header>
      <p className="text-sm text-secondary">
        The agents finished their work, but delivery setup is incomplete — the tracked deliverable cannot complete yet.
        {requirement && (
          <>
            {' '}
            <span className="font-medium">Completion mode {stream.completionMode}:</span> {requirement}.
          </>
        )}
      </p>
      {blocker && <p className="text-sm text-secondary">{blocker}</p>}
      {mismatchLines.length > 0 && (
        <ul className="text-xs text-secondary space-y-1">
          {mismatchLines.map((line) => (
            <li key={line} className="font-mono break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {gateLines.length > 0 && (
        <ul className="text-xs text-secondary space-y-1">
          {gateLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-accent/40 bg-accent/5 p-3 space-y-1">
        <p className="text-xs font-medium text-primary">Next step</p>
        <p className="text-sm text-secondary">{nextStep}</p>
        {bindCommand && (
          <code className="block p-2 rounded bg-surface font-mono text-xs text-secondary break-all">{bindCommand}</code>
        )}
      </div>
    </section>
  )
}
