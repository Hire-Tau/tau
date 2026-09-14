import type { Agent } from '@tau/shared'
import { z } from 'zod'
import type { VoiceTranscriptEntry } from '../voice/types'
import { getAgentPrimaryLabel } from './agentDisplay'

const conversationSchema = z.object({
  agentId: z.string().min(1).max(200),
  squadId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(300),
  kind: z.enum(['background', 'squad', 'agent']).optional(),
})
export type AssistantConversationLink = z.infer<typeof conversationSchema>

export function agentConversationLink(agent: Agent): AssistantConversationLink {
  return { agentId: agent.id, ...(agent.squadId ? { squadId: agent.squadId } : {}), label: getAgentPrimaryLabel(agent) }
}

const messageTools = new Set([
  'delegate_task',
  'message_agent',
  // Legacy names kept so saved transcripts still render their rows.
  'message_squad_manager',
  'message_work_stream_manager',
  'message_user_assistant',
])
const offerTools = new Set(['navigate', 'show_conversation'])
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Read durable tool receipts only; never turn arbitrary assistant text into navigation. */
export function assistantConversationLink(entry: VoiceTranscriptEntry): AssistantConversationLink | undefined {
  if (entry.role !== 'tool' || !entry.final || entry.toolError || !entry.toolResult) return
  const name = entry.toolName ?? ''
  if (!offerTools.has(name) && !messageTools.has(name)) return
  try {
    const result = record(JSON.parse(entry.toolResult))
    const receipt = record(result?.receipt) ?? result
    if (
      !result ||
      !receipt ||
      result.error ||
      receipt.error ||
      result.ok === false ||
      receipt.ok === false ||
      result.isError ||
      receipt.isError
    )
      return
    const link = conversationSchema.safeParse(receipt.conversation ?? result.conversation)
    if (link.success) return link.data
    // Existing saved message receipts also carry canonical agent IDs.
    if (
      (messageTools.has(name) || name === 'show_conversation') &&
      typeof receipt.id === 'string' &&
      typeof receipt.agentId === 'string'
    ) {
      const legacy = conversationSchema.safeParse({ agentId: receipt.agentId, label: 'Agent conversation' })
      if (legacy.success) return legacy.data
    }
  } catch {
    /* Incomplete or failed tool result. */
  }
}
