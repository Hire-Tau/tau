export interface VoiceTranscriptEntry {
  id?: string
  channel?: 'text' | 'voice'
  role: 'user' | 'assistant' | 'tool'
  text: string
  final: boolean
  toolName?: string
  toolCallId?: string
  toolArgs?: string
  toolResult?: string
  toolError?: boolean
  interrupted?: boolean
}

/**
 * Controls whether the assistant should request another model response after tool results are sent.
 * - 'auto' or true: request a follow-up response when all completed tools allow it.
 * - 'never' or false: leave the assistant listening without an automatic follow-up.
 */
export type VoiceToolFollowUpResult = 'auto' | 'never' | boolean

export interface VoiceAssistantToolExecutionResult {
  result: unknown
  followUp: VoiceToolFollowUpResult
}

export interface VoiceRateLimitRetryStatus {
  remainingMs: number
  reason: string
}

/**
 * Voice companion status state machine:
 *   idle → connecting → listening → user-speaking → processing → speaking → listening
 */
export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'user-speaking' | 'processing' | 'speaking' | 'error'
