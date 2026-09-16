import { expect, test } from 'bun:test'
import { eventTrackedResource, streamTracksEvent } from './tracked-match'
import type { IntegrationOutputAuthority } from './types'

type Event = Parameters<typeof streamTracksEvent>[1]
const connectionOne = '11111111-1111-4111-8111-111111111111'
const connectionTwo = '22222222-2222-4222-8222-222222222222'
function event(
  output: string,
  data: Record<string, unknown> = {},
  authority: IntegrationOutputAuthority = { kind: 'instance' }
): Event {
  return {
    id: 'test',
    integration: 'github',
    sourceKey: 'test',
    eventKey: 'test',
    authority,
    triggerSquadIds: [],
    lastErrorCode: null,
    matchedAt: null,
    createdAt: new Date(0),
    fact: {
      output,
      version: 1,
      data: { repository: 'acme/project', ...data },
      body: '',
      subject: 'Test',
      eventKey: 'test',
      resourceKey: 'acme/project#3',
      occurredAt: new Date(0).toISOString(),
    },
  }
}

test('provider facts carry a canonical resource identity for issues and pull requests', () => {
  expect(eventTrackedResource(event('issue.updated', { issue: { number: 3 } }))).toEqual({
    integration: 'github',
    repository: 'acme/project',
    kind: 'issue',
    number: 3,
    url: 'https://github.com/acme/project/issues/3',
  })
  expect(eventTrackedResource(event('pull_request.merged', { pullRequest: { number: 5 } }))).toEqual({
    integration: 'github',
    repository: 'acme/project',
    kind: 'pull_request',
    number: 5,
    url: 'https://github.com/acme/project/pull/5',
  })
  expect(eventTrackedResource(event('issue.updated'))).toBeNull()
  expect(eventTrackedResource(event('issue.updated', { repository: 'not-a-repo', issue: { number: 3 } }))).toBeNull()
  expect(eventTrackedResource(event('issue.updated', { issue: { number: 0 } }))).toBeNull()
  expect(eventTrackedResource({ integration: 'linear', fact: event('issue.updated').fact })).toBeNull()
})

test('tracked links match events by identity, never by kind or repository coincidence', () => {
  const issue = event('issue.updated', { issue: { number: 3 } })
  expect(
    streamTracksEvent(
      { tracked: [{ integration: 'github', repository: 'ACME/project', kind: 'issue', number: 3 }] },
      issue
    )
  ).toBe(true)
  expect(
    streamTracksEvent(
      { tracked: [{ integration: 'github', repository: 'acme/project', kind: 'pull_request', number: 3 }] },
      issue
    )
  ).toBe(false)
  expect(
    streamTracksEvent(
      { tracked: [{ integration: 'github', repository: 'acme/other', kind: 'issue', number: 3 }] },
      issue
    )
  ).toBe(false)
  expect(
    streamTracksEvent(
      { tracked: [{ integration: 'github', repository: 'acme/project', kind: 'issue', number: 4 }] },
      issue
    )
  ).toBe(false)
  // A legacy `github.issue` is not a link; only a `tracked` entry claims the issue.
  expect(streamTracksEvent({ github: { repo: 'acme/project', issue: '3' } }, issue)).toBe(false)
  expect(
    streamTracksEvent(
      {
        github: { repo: 'acme/project', issue: '3' },
        tracked: [{ integration: 'github', repository: 'acme/project', kind: 'issue', number: 3 }],
      },
      issue
    )
  ).toBe(true)
  expect(
    streamTracksEvent(
      { codeHost: { integration: 'github', repository: 'acme/project', changeRequest: { number: 5 } } },
      event('pull_request.merged', { pullRequest: { number: 5 } })
    )
  ).toBe(true)
  expect(
    streamTracksEvent(
      { sources: [{ kind: 'github_issue', url: 'https://github.com/acme/project/issues/3', addedAt: 'x' }] },
      issue
    )
  ).toBe(false)
  expect(streamTracksEvent(null, issue)).toBe(false)
  expect(streamTracksEvent({ tracked: 'nope' }, issue)).toBe(false)
})

test('a pinned connection only matches events observed through that connection', () => {
  const pinned = {
    tracked: [
      { integration: 'github', repository: 'acme/project', kind: 'issue', number: 3, connectionId: connectionOne },
    ],
  }
  const from = (connectionId: string) =>
    event('issue.updated', { issue: { number: 3 } }, { kind: 'connection', connectionId, squadId: 'squad' })
  expect(streamTracksEvent(pinned, from(connectionTwo))).toBe(false)
  expect(streamTracksEvent(pinned, from(connectionOne))).toBe(true)
  // Instance ingress carries no connection, so a pinned link still correlates.
  expect(streamTracksEvent(pinned, event('issue.updated', { issue: { number: 3 } }))).toBe(true)
})

function linearEvent(
  output: string,
  data: Record<string, unknown>,
  authority: IntegrationOutputAuthority = { kind: 'instance' }
): Event {
  const base = event(output, {}, authority)
  return { ...base, integration: 'linear', fact: { ...base.fact, data, resourceKey: 'linear-issue-uuid' } }
}
const comment = linearEvent('issue.comment', { issue: { id: 'linear-issue-uuid' } })
const updated = linearEvent('issue.updated', { issue: { id: 'linear-issue-uuid', number: 12 }, teamKey: 'eng' })
const linearLink = { integration: 'linear', repository: 'ENG', kind: 'issue', number: 12 }

test('Linear facts identify the issue by provider id, and by team key and number when they carry one', () => {
  // A comment names only the issue UUID; it is an identity, not a full resource.
  expect(eventTrackedResource(comment)).toBeNull()
  expect(eventTrackedResource(updated)).toEqual({
    integration: 'linear',
    repository: 'eng',
    kind: 'issue',
    number: 12,
    externalId: 'linear-issue-uuid',
  })
  const withId = { tracked: [{ ...linearLink, externalId: 'linear-issue-uuid' }] }
  const withoutId = { tracked: [linearLink] }
  expect(streamTracksEvent(withId, comment)).toBe(true)
  expect(streamTracksEvent(withId, updated)).toBe(true)
  expect(streamTracksEvent(withoutId, updated)).toBe(true)
  // A comment carries no team key or number, so a link that never learned the id cannot claim it.
  expect(streamTracksEvent(withoutId, comment)).toBe(false)
  // Another issue's id is another issue, even in the same team.
  expect(streamTracksEvent(withId, linearEvent('issue.comment', { issue: { id: 'other-issue-uuid' } }))).toBe(false)
  expect(
    streamTracksEvent(
      withId,
      linearEvent('issue.updated', { issue: { id: 'other-issue-uuid', number: 13 }, teamKey: 'eng' })
    )
  ).toBe(false)
  // Identity never crosses integrations: a GitHub link is not matched by a Linear fact.
  expect(
    streamTracksEvent(
      { tracked: [{ integration: 'github', repository: 'acme/project', kind: 'issue', number: 12 }] },
      updated
    )
  ).toBe(false)
  expect(streamTracksEvent(withId, linearEvent('issue.comment', { issue: {} }))).toBe(false)
})

test('provider-id matching stays scoped to the connection the link was observed under', () => {
  const pinned = { tracked: [{ ...linearLink, externalId: 'linear-issue-uuid', connectionId: connectionOne }] }
  const from = (connectionId: string) =>
    linearEvent(
      'issue.comment',
      { issue: { id: 'linear-issue-uuid' } },
      { kind: 'connection', connectionId, squadId: 'squad' }
    )
  expect(streamTracksEvent(pinned, from(connectionTwo))).toBe(false)
  expect(streamTracksEvent(pinned, from(connectionOne))).toBe(true)
})
