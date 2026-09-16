import { describe, expect, test } from 'bun:test'
import {
  deliveryPullRequests,
  parseTrackedResourceUrl,
  primaryDeliveryPullRequest,
  readDeliveryState,
  resolveTrackedResources,
  trackedResourceKey,
  trackedResourceMatches,
  trackedResourceSchema,
  trackedResourceUrl,
} from './code-hosting'

describe('tracked resources', () => {
  test('keys and urls are canonical and case-insensitive on repository', () => {
    const issue = { integration: 'github', repository: 'Acme/Widgets', kind: 'issue' as const, number: 12 }
    expect(trackedResourceKey(issue)).toBe('github:acme/widgets:issue:12')
    expect(trackedResourceUrl(issue)).toBe('https://github.com/Acme/Widgets/issues/12')
    expect(trackedResourceUrl({ ...issue, kind: 'pull_request' })).toBe('https://github.com/Acme/Widgets/pull/12')
    expect(trackedResourceUrl({ ...issue, integration: 'gitlab' })).toBeUndefined()
    expect(trackedResourceUrl({ ...issue, url: 'https://example.com/x' })).toBe('https://example.com/x')
  })

  test('parses GitHub issue and pull request URLs only', () => {
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets/issues/12')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'issue',
      number: 12,
    })
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets/pull/34/')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 34,
    })
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets')).toBeNull()
    expect(parseTrackedResourceUrl('https://gitlab.com/acme/widgets/-/issues/1')).toBeNull()
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets/issues/0')).toBeNull()
  })

  test('resolves delivery PR and tracked entries into one deduplicated list, ignoring github.issue entirely', () => {
    const metadata = {
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
      github: { repo: 'acme/widgets', issue: '12' },
      tracked: [
        { integration: 'github', repository: 'acme/widgets', kind: 'pull_request', number: 34 }, // duplicate of delivery
        {
          integration: 'github',
          repository: 'acme/other',
          kind: 'issue',
          number: 7,
          connectionId: '11111111-1111-4111-8111-111111111111',
        },
        { integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true },
        { integration: 'github', repository: 'bad', kind: 'issue', number: -1 }, // invalid, ignored
      ],
    }
    const resolved = resolveTrackedResources(metadata)
    expect(resolved.map((r) => [r.key, r.source, r.delivery])).toEqual([
      ['github:acme/widgets:pull_request:34', 'delivery', true],
      ['github:acme/other:issue:7', 'tracked', false],
      ['github:acme/other:pull_request:8', 'tracked', true],
    ])
    expect(resolved[1]!.connectionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(resolved[0]!.url).toBe('https://github.com/acme/widgets/pull/34')
  })

  test('ignores github.issue entirely when there is no codeHost binding', () => {
    expect(resolveTrackedResources({ github: { repo: 'acme/widgets', issue: '12' } })).toEqual([])
  })

  test('deliveryPullRequests and primaryDeliveryPullRequest order primary first', () => {
    const metadata = {
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
      tracked: [
        { integration: 'github', repository: 'acme/other', kind: 'pull_request', number: 8, delivery: true },
        { integration: 'github', repository: 'acme/other', kind: 'issue', number: 7 },
      ],
    }
    const pulls = deliveryPullRequests(metadata)
    expect(pulls.map((r) => r.key)).toEqual(['github:acme/widgets:pull_request:34', 'github:acme/other:pull_request:8'])
    expect(primaryDeliveryPullRequest(metadata)?.key).toBe('github:acme/widgets:pull_request:34')
    expect(primaryDeliveryPullRequest({ tracked: [] })).toBeNull()
  })

  test('readDeliveryState tolerates missing or garbage metadata', () => {
    expect(readDeliveryState(undefined)).toEqual({ pullRequests: {} })
    expect(readDeliveryState(null)).toEqual({ pullRequests: {} })
    expect(readDeliveryState({})).toEqual({ pullRequests: {} })
    expect(readDeliveryState({ delivery: 'nope' })).toEqual({ pullRequests: {} })
    expect(readDeliveryState({ delivery: { pullRequests: 'nope' } })).toEqual({ pullRequests: {} })
    const valid = { delivery: { pullRequests: { a: { state: 'open', at: '2026-01-01T00:00:00Z' } } } }
    expect(readDeliveryState(valid)).toEqual({ pullRequests: { a: { state: 'open', at: '2026-01-01T00:00:00Z' } } })
  })

  test('source links and prose URLs are never tracked', () => {
    expect(
      resolveTrackedResources({
        description: 'see https://github.com/acme/widgets/issues/99',
        sources: [
          { kind: 'github_issue', url: 'https://github.com/acme/widgets/issues/99', addedAt: '2026-01-01T00:00:00Z' },
        ],
      })
    ).toEqual([])
    expect(resolveTrackedResources(null)).toEqual([])
    expect(resolveTrackedResources({ tracked: 'nope' })).toEqual([])
  })

  test('matching respects kind, repository case and connection pinning', () => {
    const r = { integration: 'github', repository: 'Acme/Widgets', kind: 'issue' as const, number: 12 }
    const t = { integration: 'github', repository: 'acme/widgets', kind: 'issue' as const, number: 12 }
    expect(trackedResourceMatches(r, t)).toBe(true)
    expect(trackedResourceMatches(r, { ...t, kind: 'pull_request' })).toBe(false)
    expect(trackedResourceMatches(r, { ...t, connectionId: 'c1' })).toBe(true) // unpinned resource accepts any connection
    expect(trackedResourceMatches({ ...r, connectionId: 'c1' }, { ...t, connectionId: 'c2' })).toBe(false)
    expect(trackedResourceMatches({ ...r, connectionId: 'c1' }, t)).toBe(true) // event without connection (instance authority)
  })

  test('schema rejects resource urls that are not http(s)', () => {
    const base = { integration: 'github', repository: 'a/b', kind: 'issue' as const, number: 1 }
    expect(trackedResourceSchema.safeParse({ ...base, url: 'javascript:alert(1)' }).success).toBe(false)
    expect(trackedResourceSchema.safeParse({ ...base, url: 'data:text/html,<script>alert(1)</script>' }).success).toBe(
      false
    )
    expect(trackedResourceSchema.safeParse({ ...base, url: 'https://github.com/a/b/issues/1' }).success).toBe(true)
    expect(trackedResourceSchema.safeParse({ ...base, url: 'http://ghe.internal/a/b/issues/1' }).success).toBe(true)
  })

  test('schema accepts delivery designation on pull requests only', () => {
    const pr = { integration: 'github', repository: 'a/b', kind: 'pull_request' as const, number: 1 }
    const issue = { integration: 'github', repository: 'a/b', kind: 'issue' as const, number: 1 }
    expect(trackedResourceSchema.safeParse({ ...pr, delivery: true }).success).toBe(true)
    expect(trackedResourceSchema.safeParse({ ...issue, delivery: true }).success).toBe(false)
    expect(trackedResourceSchema.safeParse(pr).success).toBe(true)
  })

  test('schema rejects unknown keys and bad numbers', () => {
    expect(
      trackedResourceSchema.safeParse({ integration: 'github', repository: 'a/b', kind: 'issue', number: 1, extra: 1 })
        .success
    ).toBe(false)
    expect(
      trackedResourceSchema.safeParse({ integration: 'github', repository: 'a/b', kind: 'issue', number: 1.5 }).success
    ).toBe(false)
  })
})
