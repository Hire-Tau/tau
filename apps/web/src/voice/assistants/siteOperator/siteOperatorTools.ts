import { assistantTools, type AssistantToolEnvironment } from '../../tools/assistantTools'
import { directMessageAgentTool } from '../../tools/agentMessagingTools'
import {
  chatDrawerTool as setChatDrawerTool,
  controlAgentTool,
  createVoiceToolRegistry,
  getWorkTool,
  navigationTool as navigateTool,
  readThreadTool,
  readUserInboxTool,
  type VoiceToolExecutor,
} from '../../tools'

export type { VoiceToolExecutor }

export const siteOperatorTools = createVoiceToolRegistry<AssistantToolEnvironment>([
  ...assistantTools,
  directMessageAgentTool,
  getWorkTool,
  navigateTool,
  setChatDrawerTool,
  readUserInboxTool,
  readThreadTool,
  controlAgentTool,
])

export const siteOperatorToolDefinitions = siteOperatorTools.definitions
