import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Agent } from '../entities/Agent'

/**
 * Short-term memory tool.
 *
 * Gives agents a 10,000 character scratchpad that persists across turns.
 * The current content is injected into the system prompt at session start,
 * so it's always visible in the agent's context window.
 */

const MAX_LENGTH = 10_000

export type ShortTermMemoryToolWithKey = ToolDefinition & { key: string }

// --- Storage operations ---

export interface ShortTermMemoryStorageOps {
  read(): Promise<string>
  write(content: string): Promise<void>
}

/**
 * Create storage ops backed by an agent's context field.
 */
export function createAgentShortTermMemoryStorage(agentId: string): ShortTermMemoryStorageOps {
  return {
    async read(): Promise<string> {
      const agent = await Agent.find(agentId)
      if (!agent) return ''
      const ctx = agent.context as Record<string, unknown>
      return (ctx?.shortTermMemory as string) ?? ''
    },
    async write(content: string): Promise<void> {
      const agent = await Agent.find(agentId)
      if (!agent) throw new Error(`Agent ${agentId} not found`)
      const ctx = (agent.context as Record<string, unknown>) ?? {}
      await agent.update({
        context: { ...ctx, shortTermMemory: content },
      })
    },
  }
}

// --- TypeBox Schemas ---

const WriteSchema = Type.Object({
  content: Type.String({
    description: `Content to write to short-term memory. Maximum ${MAX_LENGTH} characters. This replaces the entire memory content.`,
    maxLength: MAX_LENGTH,
  }),
})

const EditSchema = Type.Object({
  oldText: Type.String({
    description: 'Exact text to find and replace. Must match exactly (including whitespace).',
  }),
  newText: Type.String({
    description: 'New text to replace the old text with. Can be empty to delete text.',
  }),
})

// --- Factory ---

export function createShortTermMemoryTools(storage: ShortTermMemoryStorageOps): ShortTermMemoryToolWithKey[] {
  const read: ShortTermMemoryToolWithKey = {
    name: 'short_term_memory_read',
    key: 'short_term_memory_read',
    label: 'Read Short-Term Memory',
    description:
      'Read your short-term memory. This is a 10,000 character scratchpad for notes, reminders, or any information you want to keep visible across turns.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string): Promise<AgentToolResult<unknown>> {
      const content = await storage.read()
      if (!content) {
        return {
          content: [{ type: 'text' as const, text: '(empty)' }],
          details: { length: 0 },
        }
      }
      return {
        content: [{ type: 'text' as const, text: content }],
        details: { length: content.length },
      }
    },
  }

  const write: ShortTermMemoryToolWithKey = {
    name: 'short_term_memory_write',
    key: 'short_term_memory_write',
    label: 'Write Short-Term Memory',
    description: `Write to your short-term memory. This replaces the entire content. Maximum ${MAX_LENGTH} characters.`,
    parameters: WriteSchema,
    async execute(_toolCallId: string, params: { content: string }): Promise<AgentToolResult<unknown>> {
      const content = params.content

      if (content.length > MAX_LENGTH) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Content exceeds maximum length of ${MAX_LENGTH} characters (got ${content.length}). Please shorten your content.`,
            },
          ],
          details: { error: 'too_long', length: content.length, maxLength: MAX_LENGTH },
        }
      }

      await storage.write(content)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Short-term memory updated (${content.length}/${MAX_LENGTH} chars):\n\n${content}`,
          },
        ],
        details: { length: content.length, maxLength: MAX_LENGTH },
      }
    },
  }

  const edit: ShortTermMemoryToolWithKey = {
    name: 'short_term_memory_edit',
    key: 'short_term_memory_edit',
    label: 'Edit Short-Term Memory',
    description:
      'Make a precise edit to your short-term memory using exact match find/replace. The oldText must match exactly (including whitespace). Use this for surgical edits instead of rewriting the entire content.',
    parameters: EditSchema,
    async execute(
      _toolCallId: string,
      params: { oldText: string; newText: string }
    ): Promise<AgentToolResult<unknown>> {
      const { oldText, newText } = params

      if (!oldText) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'oldText cannot be empty. Use short_term_memory_write to set content from scratch.',
            },
          ],
          details: { error: 'empty_old_text' },
        }
      }

      const currentContent = await storage.read()

      if (!currentContent) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Short-term memory is empty. Use short_term_memory_write to set initial content.',
            },
          ],
          details: { error: 'empty_memory' },
        }
      }

      if (!currentContent.includes(oldText)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not find exact match for oldText in short-term memory.\n\nSearched for:\n${oldText}\n\nCurrent content:\n${currentContent}`,
            },
          ],
          details: { error: 'no_match' },
        }
      }

      // Count occurrences
      const occurrences = currentContent.split(oldText).length - 1
      if (occurrences > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${occurrences} occurrences of oldText. Please use a more specific match that occurs exactly once.`,
            },
          ],
          details: { error: 'multiple_matches', occurrences },
        }
      }

      const updatedContent = currentContent.replace(oldText, newText)

      if (updatedContent.length > MAX_LENGTH) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Edit would exceed maximum length of ${MAX_LENGTH} characters (result would be ${updatedContent.length}). Please shorten your replacement text.`,
            },
          ],
          details: { error: 'too_long', resultLength: updatedContent.length, maxLength: MAX_LENGTH },
        }
      }

      await storage.write(updatedContent)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Short-term memory updated (${updatedContent.length}/${MAX_LENGTH} chars):\n\n${updatedContent}`,
          },
        ],
        details: { length: updatedContent.length, maxLength: MAX_LENGTH },
      }
    },
  }

  return [read, write, edit]
}

/**
 * Helper to get current short-term memory for system prompt injection.
 */
export async function getShortTermMemory(agentId: string): Promise<string> {
  const storage = createAgentShortTermMemoryStorage(agentId)
  return storage.read()
}

/**
 * Format short-term memory for inclusion in system prompt.
 * Always returns content so agents know the feature is available.
 */
export function formatShortTermMemoryPrompt(content: string): string {
  if (!content) {
    return `## Short-Term Memory
(Empty — 0/${MAX_LENGTH} chars. Use short_term_memory_write to store notes, reminders, or state you want to persist across turns. Do NOT use this as an action log or other low-signal content.)`
  }
  return `## Short-Term Memory
(${content.length}/${MAX_LENGTH} chars. Use short_term_memory_write/short_term_memory_edit to update. Do NOT use this as an action log or other low-signal content.)

${content}`
}
