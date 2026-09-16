import { describe, expect, it } from 'bun:test'
import { extractGitHubPrDispatchFact, isGitHubPrDispatchFact } from './github-pr-fact'

const event = (
  type: string,
  action: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {}
) =>
  ({
    type,
    payload: { action, repository: { full_name: 'Acme/Widgets' }, ...payload },
    metadata: { synthetic: true, ...metadata },
  }) as any
describe('GitHub PR dispatch fact', () => {
  it('extracts authoritative PR transition fields without inventing an actor', () => {
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 42,
          pull_request: {
            id: 4200,
            number: 42,
            closed_at: '2026-08-26T12:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/42',
          },
          sender: { login: 'not-the-actor' },
        })
      )
    ).toEqual({
      eventType: 'pull_request',
      action: 'closed',
      occurredAt: '2026-08-26T12:00:00.000Z',
      actorLogin: null,
      repository: 'acme/widgets',
      prNumber: 42,
      nativeId: '4200',
      providerDeliveryId: null,
      logicalRowId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      url: 'https://github.com/acme/widgets/pull/42',
    })
  })
  it('rejects ordinary issues and canonicalizes hostile URLs', () => {
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('issue_comment', 'created', {
          number: 9,
          issue: { number: 9 },
          comment: { id: 9001, created_at: '2026-08-26T12:00:00Z' },
        })
      )
    ).toBeNull()
    expect(extractGitHubPrDispatchFact('gitlab', event('pull_request', 'closed', {}))).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review', 'submitted', {
          number: 42,
          review: { id: 8001, submitted_at: '2026-08-26T12:00:00Z' },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 41,
          pull_request: { id: 4200, number: 42, closed_at: '2026-08-26T12:00:00Z' },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 42,
          pull_request: { id: 4200, number: 42, merged: true, closed_at: '2026-08-26T12:00:00Z' },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('issue_comment', 'created', {
          issue: { number: 42, pull_request: { html_url: 'https://evil.test' } },
          comment: { id: 9001, created_at: '2026-08-26T12:00:00Z', user: { login: 'ada' } },
        })
      )
    )?.toMatchObject({ url: 'https://github.com/acme/widgets/pull/42', actorLogin: 'ada' })
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 42,
          pull_request: {
            id: 4200,
            number: 42,
            closed_at: '2026-08-26T12:00:00Z',
            base: { repo: { full_name: 'other/private' } },
          },
        })
      )
    ).toBeNull()
  })
  it('preserves the authoritative merged state instead of reporting it as closed', () => {
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request', 'closed', {
          number: 42,
          pull_request: { id: 4200, number: 42, merged: true, merged_at: '2026-08-26T12:00:00Z' },
        })
      )
    )?.toMatchObject({ action: 'merged', occurredAt: '2026-08-26T12:00:00.000Z' })
  })

  it('uses nested resource authors and never substitutes a differing trigger sender', () => {
    const authored = extractGitHubPrDispatchFact(
      'github',
      event('issue_comment', 'created', {
        issue: { number: 42, pull_request: {} },
        comment: {
          id: 9002,
          created_at: '2026-08-26T12:00:00Z',
          user: { login: 'dependabot[bot]', type: 'Bot' },
        },
        sender: { login: 'maintainer' },
      })
    )
    expect(authored?.actorLogin).toBe('dependabot[bot]')
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review', 'submitted', {
          pull_request: { number: 42 },
          review: { id: 8002, submitted_at: '2026-08-26T12:00:00Z' },
          sender: { login: 'trigger-only' },
        })
      )?.actorLogin
    ).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review_comment', 'edited', {
          pull_request: { number: 42 },
          comment: { id: 7003, updated_at: '2026-08-26T12:00:00Z', user: { login: 'review-app', type: 'App' } },
          sender: { login: 'different-trigger' },
        })
      )?.actorLogin
    ).toBe('review-app')
  })

  it('accepts the supported action and authoritative timestamp matrix', () => {
    const created = '2026-08-25T00:00:00Z'
    const updated = '2026-08-26T00:00:00Z'
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      [
        'pull_request',
        'reopened',
        { number: 42, pull_request: { id: 4200, number: 42, updated_at: updated } },
        updated,
      ],
      [
        'pull_request',
        'synchronize',
        { number: 42, pull_request: { id: 4201, number: 42, updated_at: updated } },
        updated,
      ],
      [
        'issue_comment',
        'edited',
        { issue: { number: 42, pull_request: {} }, comment: { id: 9003, created_at: created, updated_at: updated } },
        updated,
      ],
      [
        'pull_request_review',
        'submitted',
        { pull_request: { number: 42 }, review: { id: 8003, submitted_at: created, updated_at: updated } },
        created,
      ],
      [
        'pull_request_review_comment',
        'created',
        { pull_request: { number: 42 }, comment: { id: 7001, created_at: created, updated_at: updated } },
        created,
      ],
      [
        'pull_request_review_comment',
        'edited',
        { pull_request: { number: 42 }, comment: { id: 7002, created_at: created, updated_at: updated } },
        updated,
      ],
    ]
    for (const [type, action, payload, expected] of cases)
      expect(extractGitHubPrDispatchFact('github', event(type, action, payload))?.occurredAt).toBe(
        new Date(expected).toISOString()
      )
  })

  it('treats edited and dismissed reviews as unsupported Activity facts', () => {
    const payload = {
      pull_request: { number: 42 },
      review: { id: 8001, submitted_at: '2026-08-25T00:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' } },
      sender: { login: 'maintainer' },
    }
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review', 'edited', payload, { providerObservedAt: '2026-08-26T00:00:00Z' })
      )
    ).toBeNull()
    expect(extractGitHubPrDispatchFact('github', event('pull_request_review', 'dismissed', payload))).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review', 'edited', {
          ...payload,
          review: { ...payload.review, updated_at: '2026-08-26T00:00:00Z' },
        })
      )
    ).toBeNull()
    expect(
      extractGitHubPrDispatchFact(
        'github',
        event('pull_request_review', 'submitted', {
          ...payload,
          review: {
            ...payload.review,
            pull_request_url: 'https://api.github.com/repos/other/private/pulls/42',
          },
        })
      )
    ).toBeNull()
  })

  it('treats inherited Object.prototype names as unsupported event types instead of throwing', () => {
    for (const type of ['constructor', 'toString', 'valueOf']) {
      expect(
        extractGitHubPrDispatchFact(
          'github',
          event(type, 'closed', { number: 42, pull_request: { id: 4200, number: 42 } })
        )
      ).toBeNull()
      expect(isGitHubPrDispatchFact({ eventType: type, action: 'closed' })).toBe(false)
    }
  })
})
