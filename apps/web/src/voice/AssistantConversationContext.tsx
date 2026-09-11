import type { RealtimeFunctionTool } from './realtimeTransport'
import type { VoiceAssistantToolExecutionResult } from './types'
import { createContext, useContext } from 'react'
import type { AssistantToolEnvironment } from './tools/assistantTools'
import type { VoiceToolExecutor } from './tools/types'
import type { VoiceTranscriptEntry } from './types'
export interface PageEditorBridge {
  prepare: () => Promise<void>
  context?: string
  getContext?: () => string
  instructions: string
  tools: RealtimeFunctionTool[]
  execute: (name: string, args: Record<string, unknown>) => Promise<VoiceAssistantToolExecutionResult>
}
export interface AssistantConversationBridge {
  openConversation?: AssistantToolEnvironment['openConversation']
  pageEditor?: PageEditorBridge
  prepareHistory: () => Promise<VoiceTranscriptEntry[]>
  delegateTask: NonNullable<VoiceToolExecutor['delegateTask']>
  messageAgent: NonNullable<AssistantToolEnvironment['messageAgent']>
}
export const AssistantConversationContext = createContext<AssistantConversationBridge | null>(null)
export const useAssistantConversationBridge = () => useContext(AssistantConversationContext)
