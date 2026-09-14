import type { ResponseContext, ThreadContext } from '../channels'

export interface KnownChannelMessage {
  provider: string
  channelId: string
  threadId?: string
  messageId: string
  source: 'channel_send' | 'channel_respond'
  createdAt: string
}

export interface ChannelConversationContext extends Record<string, unknown> {
  directMessage?: boolean
  channelInstance?: { id: string; provider: string }
  thread?: ThreadContext | null
  channelMessages?: KnownChannelMessage[]
}

export function appendKnownChannelMessage(
  context: ChannelConversationContext,
  message: KnownChannelMessage
): ChannelConversationContext {
  return {
    ...context,
    channelMessages: [...(context.channelMessages ?? []), message].slice(-50),
  }
}

export function getResponseEditChannelId(
  channelContext: ResponseContext,
  agentContext: ChannelConversationContext,
  threadId?: string
): string {
  if (channelContext.provider === 'discord') {
    return agentContext.thread?.id ?? channelContext.channelId
  }

  return channelContext.channelId
}
