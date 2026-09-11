import { describe, expect, it } from 'bun:test'
import { resolveExternalUrl } from './url-resolver'

describe('resolveExternalUrl', () => {
  it('resolves Slack thread permalinks', () => {
    expect(
      resolveExternalUrl('https://acme.slack.com/archives/C0123ABCDE/p1715800000123456?thread_ts=1715800000.123456')
    ).toEqual({ sourceType: 'slack_thread', sourceId: 'C0123ABCDE:1715800000.123456' })
  })

  it('resolves GitHub issue URLs', () => {
    expect(resolveExternalUrl('https://github.com/acme/widgets/issues/42')).toEqual({
      sourceType: 'github_issue',
      sourceId: 'acme/widgets#42',
    })
  })

  it('resolves GitHub pull request URLs as github_issue source IDs', () => {
    expect(resolveExternalUrl('https://github.com/acme/widgets/pull/43')).toEqual({
      sourceType: 'github_issue',
      sourceId: 'acme/widgets#43',
    })
  })

  it('does not resolve Linear URLs', () => {
    expect(resolveExternalUrl('https://linear.app/acme/issue/ENG-42/fix-login')).toBeNull()
  })

  it('returns null for unsupported URLs', () => {
    expect(resolveExternalUrl('https://example.com/foo')).toBeNull()
  })
})
