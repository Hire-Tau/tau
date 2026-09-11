import { z } from 'zod'

export const assistantEntrySchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(100_000),
  final: z.boolean(),
  channel: z.enum(['text', 'voice']).optional(),
  toolName: z.string().max(100).optional(),
  toolCallId: z.string().max(160).optional(),
  toolArgs: z.string().max(20_000).optional(),
  toolResult: z.string().max(100_000).optional(),
  toolError: z.boolean().optional(),
  interrupted: z.boolean().optional(),
})
export type AssistantEntry = z.infer<typeof assistantEntrySchema>
export interface AssistantConversation {
  id: string
  title: string
  managerAgentId: string | null
  createdAt: string
  updatedAt: string
}
/** Stable mailbox identity; transport connections are only temporary consumers. */
export function assistantInboxRecipientId(conversationId: string): string {
  return `assistant:${conversationId}`
}
export function parseAssistantInboxConversationId(id: string | null | undefined): string | null {
  return typeof id === 'string' && /^assistant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.slice('assistant:'.length)
    : null
}
export interface AssistantMessageReceipt {
  id: string
  agentId: string
  delivered: boolean
}
export interface AssistantInboxUpdate {
  id: string
  senderId: string | null
  senderName: string
  content: string
  subject: string | null
  replyTo: string | null
  createdAt: string
}
export interface AssistantMailbox {
  acquired: boolean
  messages: AssistantInboxUpdate[]
  pending: number
  unavailable: boolean
}
