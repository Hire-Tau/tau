import { requireAllowedChannelReply } from '../services/channel-policy'
/**
 * Channel Respond Tool
 *
 * Allows consultant agents to send responses back through external channels
 * (Discord, Slack, Telegram). The tool looks up the channel context from
 * a specific inbox message, making it explicit which message is being
 * responded to.
 *
 * Flow:
 * 1. Consultant receives inbox message with channel context in metadata
 * 2. Consultant processes the request
 * 3. Consultant calls channel_respond with messageId and response content
 * 4. Tool looks up inbox message, extracts channel context
 * 5. Provider handles response (thread creation, editing, etc.)
 * 6. Tool marks the inbox message as read
 */

import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { getProvider, type ResponseContext } from '../channels'
import { createLogger } from '../lib/infra/logger'
import {
  appendKnownChannelMessage,
  getResponseEditChannelId,
  type ChannelConversationContext,
} from './channel-message-tracking'

const log = createLogger('channel-respond')

const ChannelRespondSchema = Type.Object({
  messageId: Type.String({
    description: 'The inbox message ID to respond to.',
  }),
  content: Type.String({
    description:
      'The message to send back to the user. Supports markdown. ' +
      'Use empty string to decline responding (removes "Thinking..." message).',
  }),
})

type AgentContext = ChannelConversationContext

/**
 * Create a channel_respond tool instance for a consultant agent.
 */
export function createChannelRespondTool(): ToolDefinition {
  return {
    name: 'channel_respond',
    label: 'Channel Respond',
    description:
      'Send a response back to the user through the channel they used ' +
      '(Discord, Slack, Telegram). Specify the inbox message ID to respond to. ' +
      'This also marks the message as read.',
    parameters: ChannelRespondSchema,
    async execute(
      _toolCallId: string,
      params: { messageId: string; content: string }
    ): Promise<AgentToolResult<unknown>> {
      const { InboxMessage } = await import('../entities/InboxMessage')
      const { Agent } = await import('../entities/Agent')

      // Look up the inbox message
      const message = await InboxMessage.find(params.messageId)
      if (!message) {
        return {
          content: [{ type: 'text', text: `Error: Inbox message not found: ${params.messageId}` }],
          details: { success: false, error: 'Message not found' },
        }
      }

      // Look up the agent
      const agent = await Agent.find(message.recipientId)
      if (!agent) {
        return {
          content: [{ type: 'text', text: 'Error: Agent not found' }],
          details: { success: false, error: 'Agent not found' },
        }
      }

      // Extract channel context
      const metadata = message.metadata as Record<string, unknown> | null
      const channelContext = metadata?.channelContext as ResponseContext | undefined

      if (!channelContext?.provider) {
        return {
          content: [{ type: 'text', text: 'Error: No channel context found in message.' }],
          details: { success: false, error: 'No channel context' },
        }
      }

      let agentContext = agent.context as AgentContext

      try {
        await requireAllowedChannelReply(
          agentContext.channelInstance?.id,
          channelContext.channelId,
          agentContext.directMessage ? agent.id : undefined
        )
        let threadId: string | undefined

        // Get the provider
        const provider = getProvider(channelContext.provider)

        if (provider) {
          if (agentContext.directMessage) {
            const content = params.content.trim() ? `${agentContext.directMessageSquadName}:\n\n${params.content}` : ''
            if (channelContext.extras?.interactionToken && channelContext.provider === 'discord') {
              const { editInteractionResponse } = await import('../channels/discord/provider')
              await editInteractionResponse(
                channelContext.extras.applicationId as string,
                channelContext.extras.interactionToken as string,
                content || '…'
              )
            } else if (channelContext.messageToEdit) {
              if (content)
                await provider.editMessage({
                  channelId: channelContext.channelId,
                  messageId: channelContext.messageToEdit,
                  text: content,
                })
              else
                await provider.deleteMessage({
                  channelId: channelContext.channelId,
                  messageId: channelContext.messageToEdit,
                })
            } else if (content) {
              await provider.postMessage({
                channelId: channelContext.channelId,
                threadId: channelContext.provider === 'slack' ? channelContext.threadId : undefined,
                text: content,
              })
            }
            threadId = channelContext.threadId
          } else {
            // Add user info to context extras for thread parent editing
            if (channelContext.provider === 'slack') {
              channelContext.extras = {
                ...channelContext.extras,
                userId: metadata?.userId,
                question: extractQuestion(message.content),
              }
            }

            // Use provider's sendResponse method
            threadId = await provider.sendResponse({
              context: channelContext,
              content: params.content,
              agentContext,
              updateAgentContext: async (thread) => {
                agentContext = { ...agentContext, thread }
                await agent.update({
                  context: agentContext,
                })
              },
            })
          }
        } else {
          throw new Error(`Unknown provider: ${channelContext.provider}`)
        }

        if (channelContext.messageToEdit) {
          await agent.update({
            context: appendKnownChannelMessage(agentContext, {
              provider: channelContext.provider,
              channelId: getResponseEditChannelId(channelContext, agentContext, threadId),
              threadId: threadId ?? channelContext.threadId ?? agentContext.thread?.id,
              messageId: channelContext.messageToEdit,
              source: 'channel_respond',
              createdAt: new Date().toISOString(),
            }),
          })
        }

        log.info(`channel_respond: Sent via ${channelContext.provider} for message ${params.messageId}`)
        await message.markAsRead()

        return {
          content: [{ type: 'text', text: `Response sent via ${channelContext.provider}. Message marked as read.` }],
          details: { success: true, provider: channelContext.provider, messageId: params.messageId, threadId },
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        log.error('channel_respond error:', error)
        return {
          content: [{ type: 'text', text: `Error sending response: ${errorMsg}` }],
          details: { success: false, error: errorMsg },
        }
      }
    },
  }
}

function extractQuestion(content: string): string {
  const match = content.match(/"([^"]+)"/)
  return match?.[1] || content.slice(0, 100)
}
