import { describe, expect, test } from 'bun:test'
import { GitHubPollingProvider } from './provider'

describe('GitHubPollingProvider', () => {
  test('exposes event polling with an injected credential resolver', async () => {
    const provider = new GitHubPollingProvider(
      async () => 'squad-token',
      async () => new Response(null, { status: 304 })
    )
    const capability = provider.capabilities.event_polling!
    const connection = {
      id: 'github:s1',
      squadId: 's1',
      providerKey: 'github',
      adapterVersion: 1,
      configuration: { owner: 'acme', repo: 'widgets', number: 42 },
    }

    await capability.poll(connection, {
      etags: { pr: 'p', issue: 'i', issueComments: 'c', reviews: 'r', reviewComments: 'rc' },
      pr: { headSha: 'a', state: 'open', merged: false },
      issue: {},
      pullRequest: { state: 'open', merged: false, head: { sha: 'a' }, base: { repo: { full_name: 'acme/widgets' } } },
      issueComments: {},
      reviews: {},
      reviewComments: {},
    })

    expect(provider.key).toBe('github')
    expect(provider.parseConfig(connection.configuration)).toEqual(connection.configuration)
  })

  test('rejects malformed resource configurations', () => {
    const provider = new GitHubPollingProvider(async () => undefined)
    expect(() => provider.parseConfig({ owner: '', repo: 'x', number: 0 })).toThrow(
      'Invalid GitHub polling configuration'
    )
  })
})
