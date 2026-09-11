import type { RealtimeFunctionTool } from '../realtimeTransport'
import type { VoiceAssistantTool, VoiceToolFollowUp } from './types'

export interface VoiceToolExecutionResult {
  result: unknown
  followUp: Exclude<VoiceToolFollowUp, (result: unknown) => boolean> | boolean
}

export interface VoiceToolRegistry<TEnv = unknown> {
  definitions: RealtimeFunctionTool[]
  get(name: string): VoiceAssistantTool<TEnv> | undefined
  execute(name: string, args: Record<string, unknown>, env: TEnv): Promise<VoiceToolExecutionResult>
  summarizeCall(name: string, args: Record<string, unknown>): string
}

export function createVoiceToolRegistry<TEnv>(tools: VoiceAssistantTool<TEnv>[]): VoiceToolRegistry<TEnv> {
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]))

  return {
    definitions: tools.map((tool) => tool.definition),

    get(name) {
      return toolsByName.get(name)
    },

    async execute(name, args, env) {
      const tool = toolsByName.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)

      const result = await tool.execute(args, env)
      const errorMessage = readToolErrorMessage(result)
      if (errorMessage) throw new Error(errorMessage)
      return {
        result,
        followUp: resolveFollowUp(tool.followUp, result),
      }
    },

    summarizeCall(name, args) {
      return toolsByName.get(name)?.summarizeCall?.(args) ?? summarizeArgs(args)
    },
  }
}

function readToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const error = (result as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error.trim() : undefined
}

function resolveFollowUp(
  followUp: VoiceToolFollowUp | undefined,
  result: unknown
): VoiceToolExecutionResult['followUp'] {
  if (typeof followUp === 'function') return followUp(result)
  return followUp ?? 'auto'
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ')
}
