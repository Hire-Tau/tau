import { expect, test } from 'bun:test'
import { classifyDeliveryPresentation, type DeliveryEvent } from './delivery-state'
import type { WorkflowRun } from '@tau/shared'

const metadata = { codeHost: { integration: 'github', repository: 'acme/repo', changeRequest: { number: 42 } } }
const run = (mode = 'pr-merge', followChanges = true) =>
  ({ status: 'completion-ready', definition: { completion: { mode, followChanges } } }) as WorkflowRun
const event = (output: string, data = {}, headSha = 'a'.repeat(40), occurredAt = '2026-09-21T10:00:00Z') =>
  ({
    integration: 'github',
    output,
    version: 1,
    occurredAt,
    data: { repository: 'acme/repo', pullRequest: { number: 42, headSha }, ...data },
  }) as DeliveryEvent

test('policy, binding and tracking determine setup versus external, not PR existence alone', () => {
  expect(classifyDeliveryPresentation(run(), metadata, [])).toEqual({ kind: 'external' })
  expect(classifyDeliveryPresentation(run(), {}, [])).toEqual({ kind: 'setup' })
  expect(classifyDeliveryPresentation(run('pr-merge', false), metadata, [])).toEqual({ kind: 'setup' })
  expect(classifyDeliveryPresentation(run('review-approval'), {}, [])).toEqual({ kind: 'approval' })
  expect(classifyDeliveryPresentation({ ...run(), status: 'running' }, metadata, [])).toBeUndefined()
})
test('only positive current-head provider facts identify a human gate', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean' })])
  ).toEqual({ kind: 'merge' })
  expect(
    classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [
      event('pull_request.updated', { mergeState: 'clean' }),
    ])
  ).toEqual({ kind: 'external' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.review_requested', { requestedReviewer: 'human', requestedReviewerType: 'User' }),
    ])
  ).toEqual({
    kind: 'review',
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.ci_completed', { state: 'success' })])
  ).toEqual({ kind: 'external' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', { mergeState: 'clean' }, 'a'.repeat(40)),
      event('pull_request.updated', {}, 'b'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({ kind: 'external' })
})
test('negative current-head facts never look ready for review or merge', () => {
  for (const fact of [
    event('pull_request.ci_completed', { state: 'failure' }),
    event('pull_request.reviewed', { state: 'changes_requested' }),
    event('pull_request.updated', { mergeConflict: true }),
  ]) {
    expect(classifyDeliveryPresentation(run(), metadata, [fact])).toEqual({ kind: 'failure' })
  }
})

test('branch identity, draft state, bot requests, and old review commits cannot advertise readiness', () => {
  const configured = { ...metadata, git: { branch: 'work/branch', baseBranch: 'main' } }
  expect(
    classifyDeliveryPresentation(run(), configured, [
      event('pull_request.updated', { mergeState: 'clean', headBranch: 'other', baseBranch: 'main' }),
    ])
  ).toEqual({ kind: 'setup' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean', draft: true })])
  ).toEqual({ kind: 'external' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.review_requested', { requestedReviewerType: 'Bot' }),
    ])
  ).toEqual({ kind: 'external' })
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.reviewed', { state: 'changes_requested', reviewedHeadSha: 'b'.repeat(40) }),
    ])
  ).toEqual({ kind: 'external' })
})
test('auto-merge policy fallback requires a human only with positive merge readiness', () => {
  const clean = [event('pull_request.updated', { mergeState: 'clean' })]
  expect(classifyDeliveryPresentation(run('pr-auto-merge'), metadata, clean, { allowAutoMerge: false })).toEqual({
    kind: 'merge',
  })
  expect(classifyDeliveryPresentation(run('pr-auto-merge'), metadata, [], { allowAutoMerge: false })).toEqual({
    kind: 'external',
  })
})
test('valid direct-merge setup waits for verification, never displays delivered green', () => {
  expect(
    classifyDeliveryPresentation(
      run('direct-merge'),
      { ...metadata, git: { commit: 'a'.repeat(40), baseBranch: 'main' } },
      []
    )
  ).toEqual({ kind: 'external' })
})
test('a late old-head CI failure cannot replace the observed PR head', () => {
  expect(
    classifyDeliveryPresentation(run(), metadata, [
      event('pull_request.updated', {}, 'b'.repeat(40)),
      event('pull_request.ci_completed', { state: 'failure' }, 'a'.repeat(40), '2026-09-21T11:00:00Z'),
    ])
  ).toEqual({ kind: 'external' })
})

test('unknown or failing additional delivery PRs prevent claiming a ready primary merge', () => {
  const multiple = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  const primary = event('pull_request.updated', { mergeState: 'clean' })
  expect(classifyDeliveryPresentation(run(), multiple, [primary])).toEqual({ kind: 'external' })
  const failed = event('pull_request.updated', {
    repository: 'acme/other',
    pullRequest: { number: 8, headSha: 'b'.repeat(40) },
    mergeConflict: true,
  })
  expect(classifyDeliveryPresentation(run(), multiple, [primary, failed])).toEqual({ kind: 'failure' })
})

test('already merged additional PRs do not hide the remaining human merge', () => {
  const multiple = {
    ...metadata,
    tracked: [{ integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true }],
  }
  const primary = event('pull_request.updated', { mergeState: 'clean' })
  const merged = event('pull_request.merged', {
    repository: 'acme/other',
    pullRequest: { number: 8, headSha: 'b'.repeat(40) },
  })
  expect(classifyDeliveryPresentation(run(), multiple, [primary, merged])).toEqual({ kind: 'merge' })
  expect(classifyDeliveryPresentation(run(), metadata, [event('pull_request.merged')])).toEqual({ kind: 'external' })
})

test('unknown reviewer identity and unknown PR head never imply a human action', () => {
  expect(classifyDeliveryPresentation(run(), metadata, [event('pull_request.review_requested')])).toEqual({
    kind: 'external',
  })
  expect(
    classifyDeliveryPresentation(run(), metadata, [event('pull_request.updated', { mergeState: 'clean' }, '')])
  ).toEqual({ kind: 'external' })
})

test('malformed direct delivery metadata is setup required, never a serializer exception', () => {
  expect(
    classifyDeliveryPresentation(
      run('direct-merge'),
      { ...metadata, git: { commit: 'a'.repeat(40), baseBranch: 7 } },
      []
    )
  ).toEqual({ kind: 'setup' })
})

test('a current human review request survives later CI success and unrelated PR comments', () => {
  const request = event('pull_request.review_requested', { requestedReviewer: 'human', requestedReviewerType: 'User' })
  const ci = event('pull_request.ci_completed', { state: 'success' }, 'a'.repeat(40), '2026-09-21T11:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [request, ci])).toEqual({ kind: 'review' })
  const comment = event('pull_request.comment', { pendingHumanReview: true }, 'a'.repeat(40), '2026-09-21T12:00:00Z')
  expect(classifyDeliveryPresentation(run(), metadata, [request, ci, comment])).toEqual({ kind: 'review' })
})
