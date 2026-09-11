import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Subagent, type SubagentParentExecutionContext } from '../entities/Subagent'

const DispatchSchema = Type.Object({
  subagents: Type.Array(
    Type.Object({
      agentType: Type.Optional(Type.String({ description: "Only 'subagent' is supported in Phase A" })),
      model: Type.Optional(
        Type.String({
          description: 'Provides an explicit child model override; cannot be combined with inheritModel=true',
        })
      ),
      inheritModel: Type.Optional(
        Type.Boolean({
          description: "Copy the parent's full resolved model fallback chain; cannot be true when model is provided",
        })
      ),
      systemPrompt: Type.Optional(Type.String({ description: 'Additional role/expertise context' })),
      instructions: Type.String({ description: 'Required scoped task instructions' }),
      label: Type.Optional(Type.String({ description: 'Human-readable label' })),
    }),
    { minItems: 1 }
  ),
})

export function createDispatchTool(ctx: {
  agentId: string
  parentExecutionContext: SubagentParentExecutionContext
}): ToolDefinition {
  return {
    name: 'dispatch',
    label: 'Dispatch Subagents',
    description:
      "Dispatch one or more fresh ephemeral subagents to perform scoped tasks asynchronously. Without a model option, each child defaults through the subagent's Standard tier; model provides an explicit child override; inheritModel=true copies the parent's full resolved model fallback chain. model and inheritModel=true cannot be combined. Returns immediately with subagent IDs; results arrive later by inbox/steer.",
    parameters: DispatchSchema,
    async execute(
      _toolCallId: string,
      params: Parameters<typeof Subagent.dispatch>[0]
    ): Promise<AgentToolResult<unknown>> {
      const result = await Subagent.dispatch({
        parentAgentId: ctx.agentId,
        parentExecutionContext: ctx.parentExecutionContext,
        subagents: params.subagents,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: `Dispatched ${result.subagents.length} subagent(s): ${result.subagents.map((s) => `${s.label} (${s.subagentId})`).join(', ')}`,
          },
        ],
        details: result,
      }
    },
  }
}
