import { describe, expect, test } from 'bun:test'
import { workStreamGithubRepository, workStreamPullRequests } from './workStreamGithub'

const trackedPullRequest = (overrides: Record<string, unknown> = {}) => ({
  integration: 'github',
  repository: 'example/product',
  kind: 'pull_request',
  number: 123,
  ...overrides,
})

describe('workStreamPullRequests', () => {
  test('returns every tracked delivery pull request, primary first when a codeHost PR is bound', () => {
    const pullRequests = workStreamPullRequests({
      codeHost: { integration: 'github', repository: 'example/product', changeRequest: { number: 100 } },
      tracked: [
        trackedPullRequest({ number: 101, delivery: true }),
        trackedPullRequest({ number: 102, delivery: true }),
      ],
    })
    expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([100, 101, 102])
    expect(pullRequests[0]!.source).toBe('delivery')
    expect(pullRequests[0]!.url).toBe('https://github.com/example/product/pull/100')
    expect(pullRequests.slice(1).map((pullRequest) => pullRequest.source)).toEqual(['tracked', 'tracked'])
  })

  test('returns tracked delivery pull requests when the codeHost binding has no change request', () => {
    const pullRequests = workStreamPullRequests({
      codeHost: { integration: 'github', repository: 'example/product' },
      tracked: [trackedPullRequest({ number: 7, delivery: true })],
    })
    expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([7])
    expect(pullRequests[0]!.source).toBe('tracked')
  })

  test('returns multiple tracked delivery pull requests without any codeHost binding', () => {
    const pullRequests = workStreamPullRequests({
      tracked: [trackedPullRequest({ number: 5, delivery: true }), trackedPullRequest({ number: 6, delivery: true })],
    })
    expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([5, 6])
  })

  test('keeps a codeHost-bound change request without any tracked entries', () => {
    const pullRequests = workStreamPullRequests({
      codeHost: { integration: 'github', repository: 'example/product', changeRequest: { number: 9 } },
    })
    expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([9])
    expect(pullRequests[0]!.source).toBe('delivery')
  })

  test('ignores tracked issues and pull requests that are not flagged delivery', () => {
    const pullRequests = workStreamPullRequests({
      tracked: [
        trackedPullRequest({ kind: 'issue', number: 11, delivery: undefined }),
        trackedPullRequest({ number: 12 }),
        trackedPullRequest({ kind: 'issue', number: 13, url: 'https://github.com/example/product/issues/13' }),
      ],
    })
    expect(pullRequests).toEqual([])
  })

  test('dedupes a tracked entry that repeats the codeHost-bound pull request', () => {
    const pullRequests = workStreamPullRequests({
      codeHost: { integration: 'github', repository: 'Example/Product', changeRequest: { number: 30 } },
      tracked: [trackedPullRequest({ repository: 'example/product', number: 30, delivery: true })],
    })
    expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([30])
    expect(pullRequests).toHaveLength(1)
    expect(pullRequests[0]!.source).toBe('delivery')
  })

  test('derives github urls and passes through explicit urls for other integrations', () => {
    const pullRequests = workStreamPullRequests({
      tracked: [
        trackedPullRequest({ number: 40, delivery: true }),
        trackedPullRequest({
          integration: 'gitlab',
          repository: 'example/product',
          number: 41,
          delivery: true,
          url: 'https://gitlab.example.com/example/product/-/merge_requests/41',
        }),
        trackedPullRequest({ integration: 'gitlab', repository: 'example/product', number: 42, delivery: true }),
      ],
    })
    expect(pullRequests.map((pullRequest) => pullRequest.url)).toEqual([
      'https://github.com/example/product/pull/40',
      'https://gitlab.example.com/example/product/-/merge_requests/41',
      undefined,
    ])
  })

  test('yields nothing for legacy metadata.github alone', () => {
    expect(workStreamPullRequests({ github: { repo: 'example/product', pr: { number: 123 } } })).toEqual([])
    expect(workStreamPullRequests({ github: { repo: 'example/product' } })).toEqual([])
  })

  test('yields nothing without tracked delivery entries or a change request', () => {
    expect(workStreamPullRequests({})).toEqual([])
    expect(workStreamPullRequests(undefined)).toEqual([])
    expect(workStreamPullRequests({ tracked: 'not-an-array' })).toEqual([])
  })
})

describe('workStreamGithubRepository', () => {
  test('uses the explicit codeHost binding, with or without a change request', () => {
    expect(workStreamGithubRepository({ codeHost: { integration: 'github', repository: 'example/product' } })).toEqual({
      repository: 'example/product',
      repositoryUrl: 'https://github.com/example/product',
    })
    expect(
      workStreamGithubRepository({
        codeHost: { integration: 'github', repository: 'example/product', changeRequest: { number: 3 } },
      })
    ).toEqual({ repository: 'example/product', repositoryUrl: 'https://github.com/example/product' })
  })

  test('falls back to the primary delivery pull request repository without a github binding', () => {
    expect(workStreamGithubRepository({ tracked: [trackedPullRequest({ delivery: true })] })).toEqual({
      repository: 'example/product',
      repositoryUrl: 'https://github.com/example/product',
    })
  })

  test('returns null for non-github bindings and tracked-only non-github pull requests', () => {
    expect(
      workStreamGithubRepository({ codeHost: { integration: 'gitlab', repository: 'example/product' } })
    ).toBeNull()
    expect(
      workStreamGithubRepository({
        tracked: [trackedPullRequest({ integration: 'gitlab', delivery: true })],
      })
    ).toBeNull()
  })

  test('falls back to tracked pull requests when the codeHost binding is invalid', () => {
    expect(
      workStreamGithubRepository({
        codeHost: { integration: 'github', repository: '' },
        tracked: [trackedPullRequest({ delivery: true })],
      })
    ).toEqual({ repository: 'example/product', repositoryUrl: 'https://github.com/example/product' })
  })

  test('yields nothing for legacy metadata.github alone', () => {
    expect(workStreamGithubRepository({ github: { repo: 'example/product', pr: { number: 123 } } })).toBeNull()
  })
})
