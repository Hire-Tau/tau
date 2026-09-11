import { assistantTools, type AssistantToolEnvironment } from '../../tools/assistantTools'
import { directMessageAgentTool } from '../../tools/agentMessagingTools'
import {
  chatDrawerTool as setChatDrawerTool,
  controlAgentTool,
  createVoiceToolRegistry,
  getStatusTool,
  navigationTool as navigateTool,
  readMessageDetailTool,
  readThreadTool,
  readUserInboxTool,
  type VoiceToolExecutor,
} from '../../tools'

export type { VoiceToolExecutor }

export const siteOperatorTools = createVoiceToolRegistry<AssistantToolEnvironment>([
  ...assistantTools,
  directMessageAgentTool,
  getStatusTool,
  navigateTool,
  setChatDrawerTool,
  readUserInboxTool,
  readThreadTool,
  readMessageDetailTool,
  controlAgentTool,
])

export const siteOperatorToolDefinitions = siteOperatorTools.definitions
