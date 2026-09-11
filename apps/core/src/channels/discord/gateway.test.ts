import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { DiscordGateway, stopDiscordGateway } from './gateway'
import { discordProvider } from './provider'
import { Agent } from '../../entities/Agent'
import { ChannelInstance } from '../../entities/ChannelInstance'
import { InboxMessage } from '../../entities/InboxMessage'
import { registerProvider, type ChannelProvider } from '../provider'

function createGateway(): DiscordGateway {
  const gateway = new DiscordGateway('test-token')
  ;(gateway as unknown as { botUserId: string }).botUserId = 'UBOT'
  return gateway
}

describe('DiscordGateway mention routing', () => {
  let findByThreadIdSpy: ReturnType<typeof spyOn>
  let findByProviderSpy: ReturnType<typeof spyOn>
  let inboxSendSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    findByThreadIdSpy?.mockRestore()
    findByProviderSpy?.mockRestore()
    inboxSendSpy?.mockRestore()
    registerProvider(discordProvider)
  })

  it('ignores a regular message in a Tau-created thread when Tau is not mentioned', async () => {
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      context: {
        thread: {
          id: 'thread-1',
          channelId: 'thread-1',
          originalMessageId: 'parent-1',
          tauCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'discord',
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking-1' })),
    } as unknown as ChannelProvider
    registerProvider(provider)

    await (
      createGateway() as unknown as { handleMessageCreate: (message: unknown) => Promise<void> }
    ).handleMessageCreate({
      id: 'message-1',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: 'regular follow-up with no Tau mention',
      author: { id: 'user-1', username: 'Ada' },
      mentions: [],
    })

    expect(provider.postMessage).not.toHaveBeenCalled()
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })

  it('processes a mention in a Tau-created thread through the mention path', async () => {
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      context: {
        thread: {
          id: 'thread-1',
          channelId: 'thread-1',
          originalMessageId: 'parent-1',
          tauCreated: true,
        },
      },
    } as unknown as Agent)
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue({} as ChannelInstance)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'discord',
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: 'parent-1',
            userId: 'user-2',
            text: 'Earlier context',
            timestamp: 'parent-1',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking-1' })),
    } as unknown as ChannelProvider
    registerProvider(provider)

    await (
      createGateway() as unknown as { handleMessageCreate: (message: unknown) => Promise<void> }
    ).handleMessageCreate({
      id: 'message-1',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: '<@UBOT> current follow-up',
      author: { id: 'user-1', username: 'Ada' },
      mentions: [{ id: 'UBOT', username: 'Tau' }],
    })

    expect(provider.getThreadHistory).toHaveBeenCalledWith('thread-1', 'thread-1', 50)
    expect(provider.postMessage).toHaveBeenCalledWith({
      channelId: 'thread-1',
      text: '_Thinking..._',
    })
    expect(inboxSendSpy).toHaveBeenCalledWith({
      recipientId: 'agent-1',
      senderType: 'system',
      wakeEligible: true,
      subject: 'Channel: mention',
      content: expect.stringContaining('<@user-1>: @Tau current follow-up'),
      metadata: {
        type: 'channel_message',
        channelContext: {
          provider: 'discord',
          channelId: 'thread-1',
          messageToEdit: 'thinking-1',
        },
        userId: 'user-1',
        userName: 'Ada',
        command: 'mention',
      },
    })
  })
})

describe('stopDiscordGateway', () => {
  it('is a safe no-op when the gateway was never started (index.ts Subsystem stop wiring relies on this)', () => {
    expect(() => stopDiscordGateway()).not.toThrow()
  })
})
