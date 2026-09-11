import { getMessage, getMessages } from '../../api/agents'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export const readThreadTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'read_thread',
    description:
      "Read recent messages from an agent conversation thread. Use to check what an agent has been doing, see its latest output, or answer questions about an agent's work.",
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID whose thread to read' },
        limit: {
          type: 'number',
          description: 'Number of recent messages to fetch (default: 5, max: 20)',
        },
      },
      required: ['agentId'],
    },
  },
  async execute(args) {
    const { agentId, limit: rawLimit } = args as { agentId: string; limit?: number }
    const limit = Math.min(Math.max(rawLimit ?? 5, 1), 20)
    const { messages } = await getMessages(agentId, { limit })
    return {
      messages: messages.reverse().map((m) => {
        const blocks = m.metadata?.content
        let content: string
        if (blocks?.length) {
          content = blocks
            .map((b) => {
              if (b.type === 'text') return b.content
              if (b.type === 'thinking') return `[thinking] ${b.content}`
              if (b.type === 'tool_use') {
                const tc = b.toolCall
                const parts = [`[tool: ${tc.toolName}]`]
                if (tc.args) parts.push(`input: ${tc.args.slice(0, 200)}${tc.args.length > 200 ? '… (truncated)' : ''}`)
                if (tc.result)
                  parts.push(`output: ${tc.result.slice(0, 300)}${tc.result.length > 300 ? '… (truncated)' : ''}`)
                if (tc.isError) parts.push('(error)')
                return parts.join(' ')
              }
              return ''
            })
            .filter(Boolean)
            .join('\n')
        } else {
          content = m.content
        }
        return {
          id: m.id,
          role: m.role,
          content: content.length > 1000 ? content.slice(0, 1000) + '… (truncated)' : content,
          blockCount: blocks?.length ?? 0,
          pending: m.pending,
          createdAt: m.createdAt,
        }
      }),
    }
  },
}

export const readMessageDetailTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'read_message_detail',
    description:
      'Read the full content of a specific message or content block from an agent thread. Use after read_thread to drill into truncated messages or inspect tool call inputs/outputs in detail. Supports offset pagination for long content.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
        messageId: { type: 'string', description: 'Message ID (from read_thread results)' },
        blockIndex: {
          type: 'number',
          description: 'Content block index (0-based) to read a specific block. Omit to read all blocks.',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start reading from (default: 0). Use for paginating long content.',
        },
        limit: {
          type: 'number',
          description: 'Max characters to return (default: 500, max: 1500).',
        },
      },
      required: ['agentId', 'messageId'],
    },
  },
  async execute(args) {
    const {
      agentId,
      messageId,
      blockIndex,
      offset: rawOffset,
      limit: rawPageSize,
    } = args as {
      agentId: string
      messageId: string
      blockIndex?: number
      offset?: number
      limit?: number
    }
    const PAGE_SIZE = Math.min(rawPageSize ?? 500, 1500)
    const offset = rawOffset ?? 0

    const msg = await getMessage(agentId, messageId)
    if (!msg) return { error: 'Message not found' }

    const blocks = msg.metadata?.content
    let fullContent: string

    if (blockIndex !== undefined) {
      if (!blocks || blockIndex >= blocks.length) return { error: `Block index ${blockIndex} not found` }
      const block = blocks[blockIndex]
      if (block.type === 'tool_use') {
        const tc = block.toolCall
        fullContent = `[tool: ${tc.toolName}]\ninput: ${tc.args}\noutput: ${tc.result}${tc.isError ? '\n(error)' : ''}`
      } else {
        fullContent = block.content
      }
    } else if (blocks?.length) {
      fullContent = blocks
        .map((b, i) => {
          if (b.type === 'text') return b.content
          if (b.type === 'thinking') return `[thinking] ${b.content}`
          if (b.type === 'tool_use') {
            const tc = b.toolCall
            return `[block ${i}, tool: ${tc.toolName}]\ninput: ${tc.args}\noutput: ${tc.result}${tc.isError ? '\n(error)' : ''}`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    } else {
      fullContent = msg.content
    }

    const slice = fullContent.slice(offset, offset + PAGE_SIZE)
    const hasMore = offset + PAGE_SIZE < fullContent.length
    return {
      content: slice,
      offset,
      length: fullContent.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + PAGE_SIZE } : {}),
    }
  },
}

export const threadTools = [readThreadTool, readMessageDetailTool]
