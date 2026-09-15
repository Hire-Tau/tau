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
  expect(streamTracksEvent({ github: { repo: 'acme/project', issue: '3' } }, issue)).toBe(true)
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
