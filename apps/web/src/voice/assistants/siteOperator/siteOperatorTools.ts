import { assistantTools, type AssistantToolEnvironment } from '../../tools/assistantTools'
import { directMessageAgentTool } from '../../tools/agentMessagingTools'
import { createVoiceToolRegistry, getWorkTool, readThreadTool, type VoiceToolExecutor } from '../../tools'

export type { VoiceToolExecutor }

export const siteOperatorTools = createVoiceToolRegistry<AssistantToolEnvironment>([
  ...assistantTools,
  directMessageAgentTool,
  getWorkTool,
  readThreadTool,
])

export const siteOperatorToolDefinitions = siteOperatorTools.definitions
