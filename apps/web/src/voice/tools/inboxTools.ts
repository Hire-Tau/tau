import { getMyInbox } from '../../api/inbox'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export const readUserInboxTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'read_user_inbox',
    description:
      'Read recent messages from the human user inbox. Use when the user asks what needs attention, asks for updates, or wants to look back at agent notifications. Summarize messages unless the user asks for verbatim content.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['unread', 'read', 'all'],
          description: 'Which messages to return. Defaults to unread.',
        },
        limit: {
          type: 'number',
          description: 'Number of recent inbox messages to fetch (default: 5, max: 20).',
        },
      },
    },
  },
  async execute(args) {
    const { status = 'unread', limit: rawLimit } = args as { status?: 'unread' | 'read' | 'all'; limit?: number }
    const limit = Math.min(Math.max(rawLimit ?? 5, 1), 20)
    const includeRead = status !== 'unread'
    const messages = await getMyInbox(includeRead)
    const filtered = messages.filter((message) => {
      if (status === 'read') return Boolean(message.readAt)
      if (status === 'unread') return !message.readAt
      return true
    })

    return {
      messages: filtered.slice(0, limit).map((message) => ({
        id: message.id,
        subject: message.subject,
        content: message.content,
        senderType: message.senderType,
        senderId: message.senderId,
        senderAgent: message.senderAgent
          ? {
              id: message.senderAgent.id,
              agentTypeId: message.senderAgent.agentTypeId,
            }
          : null,
        readAt: message.readAt,
        createdAt: message.createdAt,
      })),
    }
  },
}

export const inboxTools = [readUserInboxTool]
