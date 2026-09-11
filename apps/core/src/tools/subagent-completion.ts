import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

export type CompletionStatus = 'completed' | 'blocked'

export type CompletionSignal = {
  requested: boolean
  result?: string
  status?: CompletionStatus
}

const ImDoneSchema = Type.Object({
  result: Type.String({ description: 'Complete, self-contained final output for the parent agent.' }),
  status: Type.Optional(
    Type.Union([Type.Literal('completed'), Type.Literal('blocked')], {
      description: 'Use blocked when you cannot finish and are reporting why. Defaults to completed.',
    })
  ),
})

export function createImDoneTool(ctx: { signal: CompletionSignal }): ToolDefinition {
  return {
    name: 'im_done',
    label: "I'm Done",
    description:
      'Record your explicit final result for the parent agent. Use this exactly when your scoped task is complete or blocked. ' +
      'After calling it, end your turn; the runner will deliver this result and terminate you.',
    parameters: ImDoneSchema,
    async execute(
      _toolCallId: string,
      params: { result: string; status?: CompletionStatus }
    ): Promise<AgentToolResult<unknown>> {
      ctx.signal.requested = true
      ctx.signal.result = params.result
      ctx.signal.status = params.status ?? 'completed'
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Final result recorded; end your turn — you will now terminate and your parent will receive this as your conclusory message.',
          },
        ],
        details: { success: true, status: ctx.signal.status },
      }
    },
  }
}
