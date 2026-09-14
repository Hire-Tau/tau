import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { isChannelAllowed, requireAllowedChannel } from './channel-policy'
import * as settings from './integrations/channels/settings'

const policy = { provider: 'slack', disabled: false, allowedChannelIds: [], deniedChannelIds: [] }
const originalFetch = globalThis.fetch
let token: ReturnType<typeof spyOn>
afterEach(() => {
  globalThis.fetch = originalFetch
  token?.mockRestore()
})

describe('channel policy', () => {
  test('defaults to all channels; allowlist restricts; denial and disabled win', () => {
    expect(isChannelAllowed(policy, 'C1')).toBe(true)
    expect(isChannelAllowed({ ...policy, allowedChannelIds: ['C1'] }, 'C2')).toBe(false)
    expect(isChannelAllowed({ ...policy, allowedChannelIds: ['C1'], deniedChannelIds: ['C1'] }, 'C1')).toBe(false)
    expect(isChannelAllowed({ ...policy, disabled: true }, 'C1')).toBe(false)
    expect(isChannelAllowed(policy, '')).toBe(false)
  })
  test('Discord delayed replies inherit the native thread parent, not the thread or category ID', async () => {
    token = spyOn(settings, 'getChannelIntegrationValue').mockReturnValue('fixture-token')
    let channel = { type: 11, parent_id: 'parent' }
    globalThis.fetch = (async () => Response.json(channel)) as unknown as typeof fetch
    await requireAllowedChannel({ ...policy, provider: 'discord', allowedChannelIds: ['parent'] }, 'thread')
    await expect(
      requireAllowedChannel({ ...policy, provider: 'discord', deniedChannelIds: ['parent'] }, 'thread')
    ).rejects.toThrow('excluded')
    channel = { type: 0, parent_id: 'category' }
    await requireAllowedChannel({ ...policy, provider: 'discord', allowedChannelIds: ['channel'] }, 'channel')
  })
  test('Discord policy lookup fails closed when the parent cannot be verified', async () => {
    token = spyOn(settings, 'getChannelIntegrationValue').mockReturnValue('fixture-token')
    const restricted = { ...policy, provider: 'discord', allowedChannelIds: ['parent'] }
    globalThis.fetch = (async () => new Response('', { status: 403 })) as unknown as typeof fetch
    await expect(requireAllowedChannel(restricted, 'thread')).rejects.toThrow('Cannot verify')
    globalThis.fetch = (async () => Response.json({ type: 11 })) as unknown as typeof fetch
    await expect(requireAllowedChannel(restricted, 'thread')).rejects.toThrow('parent')
  })
})
