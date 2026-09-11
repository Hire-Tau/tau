/**
 * Tools
 *
 * Centralized exports for all agent tools used across the codebase.
 */

// Artifact Builder
export { createArtifactTools, type ArtifactToolsContext } from './artifacts'

// Agent Purpose
export { createSetAgentPurposeTool } from './agent-purpose'

// Ask Human (async — records a question without halting; the agent keeps working)
export { createAsyncAskHumanTool } from './ask-human-async'

// Browser
export { createBrowserTools, type BrowserToolWithKey } from './browser'

// Heartbeat

// Navigate
export { createNavigateTool } from './navigate'

// Notify Contact
export { createNotifyContactTool } from './notify-contact'

// Subagents
export { createDispatchTool } from './dispatch'
export { createCheckSubagentsTool, createStopSubagentTool, createSubagentLifecycleTools } from './subagents'

// Docker Sandbox
export {
  createDockerSandboxedReadTool,
  createDockerSandboxedWriteTool,
  createDockerSandboxedEditTool,
  createDockerSandboxedBashTool,
  createDockerSandboxedCodingTools,
  DOCKER_SANDBOXED_TOOL_KEYS,
  type SandboxedToolWithKey,
} from './docker-sandbox'

// Squad Todo
export { createSquadTodoTools } from './squad-todo'

// Todo
export {
  createTodoTools,
  createFileTodoStorage,
  parseTodoMarkdown,
  formatTodoMarkdown,
  getUnmetDependencies,
  type TodoItem,
  type TodoStorageOps,
  type TodoToolWithKey,
} from './todo'

// Web Search
export {
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  type WebToolWithKey,
  type WebSearchToolWithKey,
} from './web-search'

// Short-Term Memory
export {
  createShortTermMemoryTools,
  createAgentShortTermMemoryStorage,
  getShortTermMemory,
  formatShortTermMemoryPrompt,
  type ShortTermMemoryToolWithKey,
} from './short-term-memory'

// Memory
export { createMemoryTools, type MemoryToolWithKey } from './memory'

// Monitor
export { createMonitorTool, type MonitorToolContext } from './monitor'

// Sandbox status
export { createSandboxStatusTool, type SandboxStatusToolContext } from './sandbox-status'

// Routing
export { createSuggestSquadTool, suggestSquadTool, type SuggestSquadToolContext } from './suggest-squad'

// Channel Respond / Messaging
export { createChannelRespondTool } from './channel-respond'
export { createChannelSendTool } from './channel-send'
export { createChannelEditTool } from './channel-edit'

// Provider-neutral integration tools
export {
  createBigbrainTools,
  BIGBRAIN_TOOL_NAMES,
  type BigbrainToolContext,
} from '../services/integrations/bigbrain/tools'
