import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderChannelRouting } from './ProviderChannelRouting'
import { LinkedChatAccounts } from '../settings/LinkedChatAccounts'
import { queryKeys, channelLinkQueryKeys } from '../../queryKeys'

function render(node: React.ReactNode, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  try {
    seed(client)
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  } finally {
    client.clear()
  }
}

describe('channel connection settings', () => {
  test('offers squad overrides and explicit trust without another bot identity form', () => {
    const html = render(<ProviderChannelRouting provider="telegram" instanceId="bot" canWrite />, (client) => {
      client.setQueryData(queryKeys.channelInstances.detail('bot'), {
        id: 'bot',
        channelSquadMap: {},
        trustedChannelIds: [],
      })
      client.setQueryData(queryKeys.squads.list(), [{ id: 'squad', name: 'Example squad' }])
    })
    expect(html).toContain('Channel routing and access')
    expect(html).toContain('Trusted channel IDs')
    expect(html).toContain('Save routing and access')
    expect(html).not.toContain('Bot ID')
    expect(html).not.toContain('Add channel instance')
  })
  for (const provider of ['telegram', 'slack', 'discord'] as const) {
    for (const allowed of [undefined, false]) {
      test(`${provider} private chat checkbox reflects ${allowed ?? 'default enabled'} policy`, () => {
        const html = render(<ProviderChannelRouting provider={provider} instanceId="bot" canWrite />, (client) => {
          client.setQueryData(queryKeys.channelInstances.detail('bot'), {
            id: 'bot',
            channelSquadMap: {},
            allowPrivateChats: allowed,
          })
          client.setQueryData(queryKeys.squads.list(), [])
        })
        expect(html).toContain('Allow private chats')
        expect(html.includes('checked=""')).toBe(allowed !== false)
      })
    }
  }
  test('read-only channel access cannot edit routing', () => {
    const html = render(<ProviderChannelRouting provider="discord" instanceId="bot" canWrite={false} />, (client) => {
      client.setQueryData(queryKeys.channelInstances.detail('bot'), {
        id: 'bot',
        channelSquadMap: {},
        trustedChannelIds: [],
      })
      client.setQueryData(queryKeys.squads.list(), [])
    })
    expect(html).toContain('<fieldset disabled=""')
    expect(html).not.toContain('Save routing and access')
  })
  test('a claimed identity requires confirmation showing the provider and exact external sender', () => {
    const html = render(<LinkedChatAccounts />, (client) =>
      client.setQueryData(channelLinkQueryKeys.all, {
        links: [],
        pending: [
          {
            id: 'proof',
            externalUserId: 'external-123',
            externalUserName: 'Ada',
            provider: 'slack',
            instanceName: 'Team workspace',
            expiresAt: '2099-01-01',
          },
        ],
      })
    )
    expect(html).toContain('external-123')
    expect(html).toContain('Team workspace')
    expect(html).toContain('slack')
    expect(html).toContain('Link this account')
    expect(html).toContain('Only confirm if you sent the code from this account.')
  })
})
