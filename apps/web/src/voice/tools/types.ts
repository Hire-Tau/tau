import type { AssistantConversationLink } from '../../lib/assistantConversationLinks'
import type { RealtimeFunctionTool } from '../realtimeTransport'

export type VoiceToolFollowUp = 'auto' | 'never' | ((result: unknown) => boolean)

export interface VoiceAssistantTool<TEnv = unknown> {
  definition: RealtimeFunctionTool
  execute(args: Record<string, unknown>, env: TEnv): Promise<unknown>
  summarizeCall?(args: Record<string, unknown>): string
  followUp?: VoiceToolFollowUp
}

export interface VoiceToolExecutor {
  navigate: (path: string) => void
  openConversation?: (conversation: AssistantConversationLink) => void
  messageAgent?: (
    agentId: string,
    content: string,
    mode?: 'steer' | 'follow-up',
    inReplyTo?: string
  ) => Promise<unknown>
  getCurrentPath?: () => string
}
