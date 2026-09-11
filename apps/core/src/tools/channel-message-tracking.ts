import type { ResponseContext, ThreadContext } from '../channels'

export interface KnownChannelMessage {
  provider: string
  channelId: string
  threadId?: string
  messageId: string
  source: 'channel_send' | 'channel_respond'
  createdAt: string
}

export interface ConciergeChannelContext extends Record<string, unknown> {
  channelInstance?: { id: string; provider: string }
  thread?: ThreadContext | null
  channelMessages?: KnownChannelMessage[]
}

export function appendKnownChannelMessage(
  context: ConciergeChannelContext,
  message: KnownChannelMessage
): ConciergeChannelContext {
  return {
    ...context,
    channelMessages: [...(context.channelMessages ?? []), message].slice(-50),
  }
}

export function getResponseEditChannelId(
  channelContext: ResponseContext,
  agentContext: ConciergeChannelContext,
  threadId?: string
): string {
  if (channelContext.provider === 'discord') {
    return agentContext.thread?.id ?? channelContext.channelId
  }

  return channelContext.channelId
}
