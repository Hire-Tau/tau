import { expect, test } from 'bun:test'
import { githubDeliverySnapshot, readGitHubDeliverySnapshot } from './delivery-presentation'

const connection = {
  id: 'connection',
  squadId: 'squad',
  providerKey: 'github',
  adapterVersion: 1,
  configuration: { owner: 'acme', repo: 'widgets', number: 7 },
}
test('the presentation cache validates its version, state vocabulary, identity and observation freshness', () => {
  const observedAt = new Date().toISOString()
  const snapshot = githubDeliverySnapshot(
    connection,
    {
      headRefOid: 'a'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
    },
    observedAt,
    true
  )!
  expect(readGitHubDeliverySnapshot({ deliveryPresentation: snapshot })).toEqual(snapshot)
  for (const overrides of [
    { version: 2 },
    { state: 'unexpected' },
    { checksState: 'green' },
    { draft: undefined },
    { mergeState: 7 },
    { observedAt: new Date(Date.now() - 600_000).toISOString() },
  ]) {
    expect(readGitHubDeliverySnapshot({ deliveryPresentation: { ...snapshot, ...overrides } })).toBeUndefined()
  }
})

test('aggregate snapshots retain explicit human requests but do not invent them for bot or unknown reviewers', () => {
  for (const [type, expected] of [
    ['User', true],
    ['Team', true],
    ['Bot', false],
    ['Unknown', false],
  ] as const) {
    const snapshot = githubDeliverySnapshot(
      connection,
      {
        headRefOid: 'a'.repeat(40),
        state: 'OPEN',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: type } }] },
      },
      new Date().toISOString(),
      true
    )
    expect(snapshot?.pendingHumanReview).toBe(expected)
  }
})
