import { requireAllowedChannelReply } from '../services/channel-policy'
import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getProvider } from '../channels'
import { createLogger } from '../lib/infra/logger'
import { appendKnownChannelMessage, type ChannelConversationContext } from './channel-message-tracking'

const log = createLogger('channel-send')

const ChannelSendSchema = Type.Object({
  content: Type.String({ description: 'Message to post. Supports markdown.' }),
})

export function createChannelSendTool(agentId: string): ToolDefinition {
  return {
    name: 'channel_send',
    label: 'Channel Send',
    description:
      'Post a new follow-up message to the active external channel thread. Use after channel_respond for progress or final updates.',
    parameters: ChannelSendSchema,
    async execute(_toolCallId: string, params: { content: string }): Promise<AgentToolResult<unknown>> {
      const { Agent } = await import('../entities/Agent')
      const agent = await Agent.find(agentId)
      if (!agent) return failure('Agent not found')

      const agentContext = (agent.context ?? {}) as ChannelConversationContext
      const providerName = agentContext.channelInstance?.provider
      if (!providerName) return failure('No active channel provider found in agent context')

      const thread = agentContext.thread
      if (!thread?.channelId) return failure('No active channel thread found in agent context')

      const provider = getProvider(providerName)
      if (!provider) return failure(`Unknown provider: ${providerName}`)

      try {
        await requireAllowedChannelReply(
          agentContext.channelInstance?.id,
          thread.channelId,
          agentContext.directMessage ? agentId : undefined
        )
        const result = await provider.postMessage({
          channelId: thread.channelId,
          threadId: agentContext.directMessage && providerName !== 'slack' ? undefined : thread.id,
          text: agentContext.directMessage
            ? `${agentContext.directMessageSquadName}:\n\n${params.content}`
            : params.content,
        })
        await agent.update({
          context: appendKnownChannelMessage(agentContext, {
            provider: providerName,
            channelId: result.editChannelId ?? thread.channelId,
            threadId: result.threadId ?? thread.id,
            messageId: result.messageId,
            source: 'channel_send',
            createdAt: new Date().toISOString(),
          }),
        })

        return {
          content: [
            { type: 'text', text: `Message sent via ${providerName}. Provider message ID: ${result.messageId}` },
          ],
          details: {
            success: true,
            provider: providerName,
            messageId: result.messageId,
            threadId: result.threadId ?? thread.id,
          },
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        log.error('channel_send error:', error)
        return failure(errorMsg)
      }
    },
  }
}

function failure(error: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: `Error sending channel message: ${error}` }],
    details: { success: false, error },
  }
}
