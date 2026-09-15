import { describe, expect, test } from 'bun:test'
import { extractGitHubDispatchFact, validateGitHubDispatchFact } from './dispatch-facts'

const watch = (configuration: unknown, providerKey = 'github') => ({
  providerKey,
  connection: { configuration },
})
const ISSUE_WATCH = watch({ kind: 'issue-events', owner: 'Acme', repo: 'Widgets' })
const PR_WATCH = watch({ owner: 'Acme', repo: 'Widgets', number: 42 })

const issueEvent = (repository = 'acme/widgets') => ({
  type: 'issues',
  payload: {
    action: 'closed',
    repository: { full_name: repository },
    sender: { login: 'noahsaso' },
    issue: {
      id: 9912,
      number: 12,
      title: 'Ship it',
      closed_at: '2026-09-10T06:00:00Z',
      updated_at: '2026-09-10T06:00:00Z',
      html_url: `https://github.com/${repository}/issues/12`,
    },
  },
  metadata: { synthetic: true },
})
const prEvent = (repository = 'acme/widgets', number = 42) => ({
  type: 'pull_request',
  payload: {
    action: 'closed',
    number,
    repository: { full_name: repository },
    pull_request: {
      id: 4200,
      number,
      closed_at: '2026-09-10T06:00:00Z',
      html_url: `https://github.com/${repository}/pull/${number}`,
    },
  },
  metadata: {},
})

const issueFact = extractGitHubDispatchFact('github', issueEvent() as never, ISSUE_WATCH)!
const prFact = extractGitHubDispatchFact('github', prEvent() as never, PR_WATCH)!

describe('GitHub polling dispatch facts', () => {
  test('an issue-events watch claims its own repository and nothing else', () => {
    expect(issueFact).toMatchObject({
      eventType: 'issues',
      action: 'closed',
      repository: 'acme/widgets',
      issueNumber: 12,
    })
    // Another repository's issue never becomes this watch's fact.
    expect(extractGitHubDispatchFact('github', issueEvent('acme/gadgets') as never, ISSUE_WATCH)).toBeNull()
    // The issue branch never falls through to the PR extractor.
    expect(extractGitHubDispatchFact('github', prEvent() as never, ISSUE_WATCH)).toBeNull()
  })

  test('a PR watch still matches on repository AND number only', () => {
    expect(prFact).toMatchObject({ eventType: 'pull_request', repository: 'acme/widgets', prNumber: 42 })
    expect(extractGitHubDispatchFact('github', prEvent('acme/widgets', 43) as never, PR_WATCH)).toBeNull()
    expect(extractGitHubDispatchFact('github', prEvent('acme/gadgets') as never, PR_WATCH)).toBeNull()
    // A PR watch is scoped to one change request, so a repository issue is not its business.
    expect(extractGitHubDispatchFact('github', issueEvent() as never, PR_WATCH)).toBeNull()
  })

  test('a watch that cannot name its repository claims nothing', () => {
    for (const configuration of [
      null,
      undefined,
      'not-an-object',
      { kind: 'issue-events' },
      { kind: 'issue-events', owner: 'Acme' },
      { kind: 'issue-events', repo: 'Widgets' },
      { kind: 'issue-events', owner: '  ', repo: 'Widgets' },
      { owner: 'Acme', repo: 'Widgets' },
      { owner: 'Acme', repo: 'Widgets', number: '42' },
    ]) {
      expect(extractGitHubDispatchFact('github', issueEvent() as never, watch(configuration))).toBeNull()
      expect(extractGitHubDispatchFact('github', prEvent() as never, watch(configuration))).toBeNull()
    }
    // A non-GitHub watch never yields a GitHub fact, whatever its configuration says.
    expect(
      extractGitHubDispatchFact('github', issueEvent() as never, watch(ISSUE_WATCH.connection.configuration, 'linear'))
    ).toBeNull()
  })

  test('completed-dispatch validation is symmetric with extraction', () => {
    expect(validateGitHubDispatchFact({ eventFact: issueFact }, ISSUE_WATCH)).toBe(true)
    expect(validateGitHubDispatchFact({ eventFact: prFact }, PR_WATCH)).toBe(true)
    // A dispatch carrying the other family's fact is never this watch's.
    expect(validateGitHubDispatchFact({ eventFact: prFact }, ISSUE_WATCH)).toBe(false)
    expect(validateGitHubDispatchFact({ eventFact: issueFact }, PR_WATCH)).toBe(false)
    expect(validateGitHubDispatchFact({ eventFact: { ...issueFact, repository: 'acme/gadgets' } }, ISSUE_WATCH)).toBe(
      false
    )
    expect(validateGitHubDispatchFact({ eventFact: issueFact }, watch({ kind: 'issue-events', owner: 'Acme' }))).toBe(
      false
    )
    for (const fact of [null, undefined, {}, 'nope']) {
      expect(validateGitHubDispatchFact({ eventFact: fact }, ISSUE_WATCH)).toBe(false)
      expect(validateGitHubDispatchFact({ eventFact: fact }, PR_WATCH)).toBe(false)
    }
  })
})
