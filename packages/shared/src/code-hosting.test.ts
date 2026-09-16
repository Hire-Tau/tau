import { describe, expect, test } from 'bun:test'
import {
  deliveryPullRequests,
  describeCodeHostReference,
  parseTrackedResourceReference,
  parseTrackedResourceUrl,
  primaryDeliveryPullRequest,
  readDeliveryState,
  resolveCodeHostReference,
  resolveTrackedResources,
  trackedResourceKey,
  trackedResourceLabel,
  trackedResourceMatches,
  trackedResourceObjectSchema,
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

  test('parses Linear issue URLs, rejecting http and requiring a valid key-number', () => {
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123/some-slug-here')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123/')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://LINEAR.APP/acme/issue/eng-123')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('http://linear.app/acme/issue/ENG-123')).toBeNull()
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/123')).toBeNull()
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-0')).toBeNull()
  })

  test('a comment fragment or query string still names the issue or pull request it hangs off', () => {
    // The link a person copies out of a notification points at the comment, not the resource.
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123/some-slug#comment-9f2c1b')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123#comment-9f2c1b')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123?workspace=acme')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets/issues/12#issuecomment-4412')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'issue',
      number: 12,
    })
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets/pull/34/?diff=split#discussion_r1')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      kind: 'pull_request',
      number: 34,
    })
    // A fragment is not a path: it can never turn a non-resource link into one.
    expect(parseTrackedResourceUrl('https://github.com/acme/widgets#issues/12')).toBeNull()
    expect(parseTrackedResourceUrl('https://linear.app/acme/issue/ENG-123/slug/more#comment-1')).toBeNull()
  })

  test('parseTrackedResourceReference parses both provider forms and rejects garbage', () => {
    expect(parseTrackedResourceReference('acme/widgets#12')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      number: 12,
    })
    expect(parseTrackedResourceReference('Acme/Widgets#12')).toEqual({
      integration: 'github',
      repository: 'acme/widgets',
      number: 12,
    })
    expect(parseTrackedResourceReference('ENG-123')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceReference('eng-123')).toEqual({
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 123,
    })
    expect(parseTrackedResourceReference('not a reference')).toBeNull()
    expect(parseTrackedResourceReference('ENG-0')).toBeNull()
    expect(parseTrackedResourceReference('acme/widgets#0')).toBeNull()
    expect(parseTrackedResourceReference('')).toBeNull()
  })

  test('trackedResourceLabel formats github as owner/repo#n and linear as KEY-n', () => {
    expect(trackedResourceLabel({ integration: 'github', repository: 'acme/widgets', number: 12 })).toBe(
      'acme/widgets#12'
    )
    expect(trackedResourceLabel({ integration: 'linear', repository: 'eng', number: 123 })).toBe('ENG-123')
  })

  test('trackedResourceUrl for linear only returns the stored url, never synthesizes one', () => {
    expect(trackedResourceUrl({ integration: 'linear', repository: 'eng', kind: 'issue', number: 123 })).toBeUndefined()
    expect(
      trackedResourceUrl({
        integration: 'linear',
        repository: 'eng',
        kind: 'issue',
        number: 123,
        url: 'https://linear.app/acme/issue/ENG-123/some-slug',
      })
    ).toBe('https://linear.app/acme/issue/ENG-123/some-slug')
  })

  test('schema accepts an optional externalId', () => {
    const base = { integration: 'linear', repository: 'eng', kind: 'issue' as const, number: 1 }
    expect(trackedResourceObjectSchema.safeParse(base).success).toBe(true)
    expect(trackedResourceObjectSchema.safeParse({ ...base, externalId: 'issue-uuid-123' }).success).toBe(true)
    expect(trackedResourceObjectSchema.safeParse({ ...base, externalId: '' }).success).toBe(false)
    expect(trackedResourceObjectSchema.safeParse({ ...base, externalId: 'x'.repeat(201) }).success).toBe(false)
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

  test('matching also succeeds provider-neutrally via externalId, even when the target omits repository/number/kind', () => {
    const resource = {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue' as const,
      number: 123,
      externalId: 'issue-uuid-abc',
    }
    expect(trackedResourceMatches(resource, { integration: 'linear', externalId: 'issue-uuid-abc' })).toBe(true)
    // Different integration never matches, even with the same externalId.
    expect(trackedResourceMatches(resource, { integration: 'github', externalId: 'issue-uuid-abc' })).toBe(false)
    // Mismatched externalId never matches.
    expect(trackedResourceMatches(resource, { integration: 'linear', externalId: 'other-id' })).toBe(false)
    // Connection pinning still applies even when matching via externalId.
    expect(
      trackedResourceMatches(
        { ...resource, connectionId: 'c1' },
        { integration: 'linear', externalId: 'issue-uuid-abc', connectionId: 'c2' }
      )
    ).toBe(false)
    // No externalId on the resource: falls back to normal identity matching (fails when repository/number missing).
    expect(
      trackedResourceMatches(
        { integration: 'linear', repository: 'eng', kind: 'issue', number: 123 },
        { integration: 'linear', externalId: 'issue-uuid-abc' }
      )
    ).toBe(false)
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

describe('code host reference', () => {
  const binding = {
    integration: 'github',
    repository: 'example-org/example-repo',
    changeRequest: { number: 1482, url: 'https://github.com/example-org/example-repo/pull/1482' },
  }

  test('a well-formed binding resolves', () => {
    expect(resolveCodeHostReference({ codeHost: binding })).toEqual(binding)
    expect(describeCodeHostReference({ codeHost: binding })).toEqual({ status: 'valid', reference: binding })
  })

  test('a change request url that is not http(s) fails the binding closed', () => {
    const scripted = { ...binding, changeRequest: { number: 1, url: 'javascript:alert(1)' } }
    expect(resolveCodeHostReference({ codeHost: scripted })).toBeNull()
    const described = describeCodeHostReference({ codeHost: scripted })
    expect(described.status).toBe('invalid')
    expect(described.status === 'invalid' && described.issues).toEqual([
      'codeHost.changeRequest.url: must be an http(s) URL',
    ])
    expect(
      resolveCodeHostReference({
        codeHost: { ...binding, changeRequest: { number: 1, url: 'http://ghe.internal/a/b/pull/1' } },
      })
    ).not.toBeNull()
  })

  test('a change request url is bounded like every other stored link', () => {
    const long = `https://github.com/a/b/pull/1?x=${'y'.repeat(2000)}`
    expect(resolveCodeHostReference({ codeHost: { ...binding, changeRequest: { number: 1, url: long } } })).toBeNull()
  })

  test('extra keys on the change request are reported as invalid, never as an absent binding', () => {
    const annotated = {
      codeHost: {
        ...binding,
        changeRequest: { ...binding.changeRequest, state: 'MERGED', verifiedAt: '2026-09-15T20:53:18Z' },
      },
    }
    expect(resolveCodeHostReference(annotated)).toBeNull()
    const described = describeCodeHostReference(annotated)
    expect(described.status).toBe('invalid')
    expect(described.status === 'invalid' && described.issues).toEqual([
      'codeHost.changeRequest: unknown keys `state`, `verifiedAt` (allowed: number, url)',
    ])
  })

  test('missing required fields and bad values are described with their paths', () => {
    const described = describeCodeHostReference({ codeHost: { integration: 'GitHub', changeRequest: { number: 0 } } })
    expect(described.status).toBe('invalid')
    const issues = described.status === 'invalid' ? described.issues : []
    expect(issues.some((issue) => issue.startsWith('codeHost.integration:'))).toBe(true)
    expect(issues.some((issue) => issue.startsWith('codeHost.repository:'))).toBe(true)
    expect(issues.some((issue) => issue.startsWith('codeHost.changeRequest.number:'))).toBe(true)
  })

  test('metadata without any binding is absent, and the legacy github shape still resolves', () => {
    expect(describeCodeHostReference({})).toEqual({ status: 'absent' })
    expect(describeCodeHostReference(null)).toEqual({ status: 'absent' })
    expect(describeCodeHostReference({ delivery: {} })).toEqual({ status: 'absent' })
    expect(resolveCodeHostReference({ github: { repo: 'owner/repo', pr: { number: '7' } } })).toEqual({
      integration: 'github',
      repository: 'owner/repo',
      changeRequest: { number: 7 },
    })
  })
})
