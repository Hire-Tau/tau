import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { SUBAGENT_LIST_RECENT_WITHIN_DAYS, Subagent } from '../entities/Subagent'
import { formatSubagentStatuses } from '../lib/prompts/subagent-status'

const CheckSubagentsSchema = Type.Object({
  recentWithinDays: Type.Optional(
    Type.Number({
      minimum: 0,
      description: `Only show terminated subagents active within the last N days (default ${SUBAGENT_LIST_RECENT_WITHIN_DAYS}); live subagents are always shown.`,
    })
  ),
})

export function createCheckSubagentsTool(ctx: { agentId: string }): ToolDefinition {
  return {
    name: 'check_subagents',
    label: 'Check Subagents',
    description: "List this agent's subagent children with their labels, status, last activity, and result status.",
    parameters: CheckSubagentsSchema,
    async execute(_toolCallId: string, params: { recentWithinDays?: number } = {}): Promise<AgentToolResult<unknown>> {
      const children = await Subagent.listChildren(ctx.agentId, { recentWithinDays: params.recentWithinDays })
      return {
        content: [
          {
            type: 'text' as const,
            text: formatSubagentStatuses(children),
          },
        ],
        details: { subagents: children },
      }
    },
  }
}

const StopSubagentSchema = Type.Object({
  subagentId: Type.String({ description: 'Subagent id to stop' }),
  reason: Type.Optional(Type.String({ description: 'Optional reason to include in the stopped result' })),
})

export function createStopSubagentTool(ctx: { agentId: string }): ToolDefinition {
  return {
    name: 'stop_subagent',
    label: 'Stop Subagent',
    description: "Stop one of this agent's live subagents and deliver a stopped result.",
    parameters: StopSubagentSchema,
    async execute(
      _toolCallId: string,
      params: { subagentId: string; reason?: string }
    ): Promise<AgentToolResult<unknown>> {
      const result = await Subagent.stop({
        parentAgentId: ctx.agentId,
        subagentId: params.subagentId,
        reason: params.reason,
      })
      return {
        content: [{ type: 'text' as const, text: `${result.status} subagent ${params.subagentId}` }],
        details: { subagentId: params.subagentId, resultStatus: result.status },
      }
    },
  }
}

export function createSubagentLifecycleTools(ctx: { agentId: string }): ToolDefinition[] {
  return [createCheckSubagentsTool(ctx), createStopSubagentTool(ctx)]
}
