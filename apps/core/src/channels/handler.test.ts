import { describe, it, expect, mock, afterEach, spyOn } from 'bun:test'
import { handleChannelEvent } from './handler'
import { ChannelInstance } from '../entities/ChannelInstance'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import type { ChannelProvider, InboundMessage } from './provider'

describe('handleChannelEvent mention routing', () => {
  let findByProviderSpy: ReturnType<typeof spyOn>
  let findByThreadIdSpy: ReturnType<typeof spyOn>
  let inboxSendSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    findByProviderSpy?.mockRestore()
    findByThreadIdSpy?.mockRestore()
    inboxSendSpy?.mockRestore()
  })

  it('queues a Slack app mention in a channel for concierge with a managed thread context', async () => {
    const queueForConcierge = mock(() => Promise.resolve('agent-1'))
    const channelInstance = { queueForConcierge } as unknown as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)

    const postMessage = mock(() => Promise.resolve({ messageId: 'unused', threadId: 'unused' }))
    const postMentionThinkingIndicator = mock(() =>
      Promise.resolve({ messageId: '1710000000.000200', threadId: '1710000000.000100' })
    )
    const provider = {
      name: 'slack',
      postMessage,
      postMentionThinkingIndicator,
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
    } as unknown as ChannelProvider

    const result = await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Tau can you help?',
        channelId: 'C123',
        user: { id: 'U123', name: 'U123' },
        messageId: '1710000000.000100',
        isInThread: false,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(findByProviderSpy).toHaveBeenCalledWith('slack', 'T123')
    expect(postMentionThinkingIndicator).toHaveBeenCalledWith({
      type: 'mention',
      text: '@Tau can you help?',
      channelId: 'C123',
      user: { id: 'U123', name: 'U123' },
      messageId: '1710000000.000100',
      isInThread: false,
      raw: { teamId: 'T123' },
    })
    expect(postMessage).not.toHaveBeenCalled()
    expect(queueForConcierge).toHaveBeenCalledWith({
      command: 'mention',
      content: '@Tau can you help?',
      user: { id: 'U123', name: 'U123' },
      responseContext: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '1710000000.000100',
        messageToEdit: '1710000000.000200',
        tauInitiated: true,
        extras: { teamId: 'T123' },
      },
    })
    expect(result).toEqual({ response: { ok: true } })
  })

  it('processes a mention in a Tau-created Slack thread instead of relying on regular message handling', async () => {
    const channelInstance = {} as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      context: {
        thread: {
          id: '1710000000.000100',
          channelId: 'C123',
          originalMessageId: '1710000000.000100',
          tauCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text.replace(/<@UBOT>/g, '@Tau'),
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1710000000.000100',
            userId: 'U456',
            userName: 'Grace (Grace Hopper, @grace, <@U456>)',
            text: 'Earlier context',
            timestamp: '1710000000.000100',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Tau current follow-up',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(provider.postMessage).toHaveBeenCalledWith({
      channelId: 'C123',
      text: '_Thinking..._',
      threadId: '1710000000.000100',
    })
    const sent = inboxSendSpy.mock.calls[0]?.[0] as any
    expect(sent.content).toContain('Countess (Ada Lovelace, @ada, <@U123>): @Tau current follow-up')
    expect(sent).toMatchObject({
      recipientId: 'agent-1',
      senderType: 'system',
      subject: 'Channel: mention',
      metadata: {
        type: 'channel_message',
        channelContext: {
          provider: 'slack',
          channelId: 'C123',
          threadId: '1710000000.000100',
          messageToEdit: '1710000002.000300',
          tauInitiated: false,
          extras: { teamId: 'T123' },
        },
        userId: 'U123',
        userName: 'Countess (Ada Lovelace, @ada, <@U123>)',
        command: 'mention',
      },
    })
  })

  it('ignores a regular message in a Tau-created Slack thread when Tau is not mentioned', async () => {
    const channelInstance = {} as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      context: {
        thread: {
          id: '1710000000.000100',
          channelId: 'C123',
          originalMessageId: '1710000000.000100',
          tauCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    const result = await handleChannelEvent(
      provider,
      {
        type: 'message',
        text: 'regular follow-up with no Tau mention',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(provider.postMessage).not.toHaveBeenCalled()
    expect(inboxSendSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ response: { ok: true } })
  })

  it('routes active concierge mentions with history only since the latest Tau response', async () => {
    const channelInstance = {} as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({ id: 'agent-1' } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text,
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1',
            userId: 'U1',
            userName: 'Before',
            text: 'before latest Tau',
            timestamp: '1',
            isBotMessage: false,
          },
          {
            messageId: '2',
            userId: 'UBOT',
            userName: 'Tau',
            text: 'latest Tau response',
            timestamp: '2',
            isBotMessage: true,
          },
          {
            messageId: '3',
            userId: 'U2',
            userName: 'After',
            text: 'after latest Tau',
            timestamp: '3',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking', threadId: 'thread-1' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Tau current',
        channelId: 'C123',
        user: { id: 'U3', name: 'Current' },
        threadId: 'thread-1',
        messageId: '4',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    const sent = inboxSendSpy.mock.calls[0]?.[0] as any
    expect(sent.content).not.toContain('before latest Tau')
    expect(sent.content).toContain('@Tau: latest Tau response')
    expect(sent.content).toContain('After: after latest Tau')
    expect(sent.content).toContain('Current: @Tau current')
  })

  it('spawns a replacement concierge with full thread history when no active thread agent exists', async () => {
    let queued: InboundMessage | undefined
    const queueForConcierge = mock((inbound: InboundMessage) => {
      queued = inbound
      return Promise.resolve('agent-replacement')
    })
    const channelInstance = { queueForConcierge } as unknown as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue(null)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text,
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1',
            userId: 'U1',
            userName: 'Before',
            text: 'before latest Tau',
            timestamp: '1',
            isBotMessage: false,
          },
          {
            messageId: '2',
            userId: 'UBOT',
            userName: 'Tau',
            text: 'latest Tau response',
            timestamp: '2',
            isBotMessage: true,
          },
          {
            messageId: '3',
            userId: 'U2',
            userName: 'After',
            text: 'after latest Tau',
            timestamp: '3',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking', threadId: 'thread-1' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Tau current',
        channelId: 'C123',
        user: { id: 'U3', name: 'Current' },
        threadId: 'thread-1',
        messageId: '4',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(queueForConcierge).toHaveBeenCalledTimes(1)
    expect(queued?.content).toContain('Before: before latest Tau')
    expect(queued?.content).toContain('@Tau: latest Tau response')
    expect(queued?.content).toContain('After: after latest Tau')
    expect(queued?.content).toContain('Current: @Tau current')
  })

  it('preserves the enriched current Slack sender label in joined thread history', async () => {
    let queued: InboundMessage | undefined
    const queueForConcierge = mock((inbound: InboundMessage) => {
      queued = inbound
      return Promise.resolve('agent-1')
    })
    const channelInstance = { queueForConcierge } as unknown as ChannelInstance
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue(null)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text.replace(/<@UBOT>/g, '@Tau'),
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1710000000.000100',
            userId: 'U456',
            userName: 'Grace (Grace Hopper, @grace, <@U456>)',
            text: 'Earlier context for <@UBOT>',
            timestamp: '1710000000.000100',
            isBotMessage: false,
          },
          {
            messageId: '1710000000.000150',
            userId: 'U789',
            userName: 'Katherine Johnson (@katherine, <@U789>)',
            text: 'Additional historical context',
            timestamp: '1710000000.000150',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Tau current follow-up',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(queueForConcierge).toHaveBeenCalledTimes(1)
    expect(queued?.content).toContain('Grace (Grace Hopper, @grace, <@U456>): Earlier context for @Tau')
    expect(queued?.content).toContain('Katherine Johnson (@katherine, <@U789>): Additional historical context')
    expect(queued?.content).toContain('Countess (Ada Lovelace, @ada, <@U123>): @Tau current follow-up')
    expect(queued?.content).not.toContain('<@U123>: @Tau current follow-up')
  })
})
