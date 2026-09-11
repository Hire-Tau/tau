import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { QuestionItem, QuestionType } from '@tau/shared'
import { createAgentQuestion } from '../services/agents/questions'

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: 'The value returned when this option is selected' }),
  label: Type.Optional(Type.String({ description: 'Display label (defaults to value if not provided)' })),
})

const QuestionItemSchema = Type.Object({
  id: Type.String({ description: 'Unique identifier for this question (used in the response)' }),
  type: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('select'), Type.Literal('multi-select')], {
      description: "The type of input expected. Defaults to 'text'",
    })
  ),
  question: Type.String({ description: 'The question text to display' }),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, { description: 'Options for select/multi-select questions.' })
  ),
  default: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  optional: Type.Optional(Type.Boolean({ description: 'If true, this question can be left unanswered' })),
})

const AsyncAskHumanSchema = Type.Object({
  questions: Type.Array(QuestionItemSchema, {
    description: 'One or more questions to ask. Each has an id, type, question text, and optional options.',
  }),
  waitScope: Type.Optional(
    Type.Union([Type.Literal('attempt'), Type.Literal('stream')], {
      description:
        'For blocking questions: default is your active flow attempt; use stream only when every branch needs the answer. Non-flow work uses whole-stream waits.',
    })
  ),
  blocking: Type.Optional(
    Type.Boolean({
      description:
        'Default false. When true, a wait prevents the affected flow attempt from advancing until answered. ' +
        'Independent branches can continue. The stream may park after the squad grace only when no branch can proceed. ' +
        'The tool returns immediately; finish your current turn when blocked rather than polling.',
    })
  ),
})

type AskParams = {
  questions: Array<{
    id: string
    type?: QuestionType
    question: string
    options?: { value: string; label?: string }[]
    default?: string | string[]
    optional?: boolean
  }>
  blocking?: boolean
  waitScope?: 'attempt' | 'stream'
}

function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], details: { error: message } }
}

/**
 * Async ask_human: records a structured question and returns immediately — the agent does NOT halt.
 * Anyone with canonical read access to the agent sees the question in its conversation/history; Action
 * Center/push attention routes to consumed execution participants, attributable work-stream
 * requesters, compatible owners, and relevant authorized watchers. Having no safe attention
 * recipient is NOT the same as an unreadable question. The answer arrives later as an inbox
 * message. A blocking question pauses its work scope, not the tool call or independent branches.
 */
export interface AsyncAskHumanOrigin {
  agentId: string
  executionId: string
  flushPersistence: () => Promise<void>
}

export function createAsyncAskHumanTool(
  origin: AsyncAskHumanOrigin,
  dependencies: { createQuestion: typeof createAgentQuestion } = { createQuestion: createAgentQuestion }
): ToolDefinition {
  return {
    name: 'ask_human',
    label: 'Ask Human',
    description:
      'Ask one or more structured questions of the humans responsible for this agent (your owner and ' +
      'the watchers of your squad). The tool returns immediately; the answer arrives later in your inbox. ' +
      'Set blocking true when your current step needs the answer before proceeding, then end your turn; ' +
      'independent branches can continue. An answer does not approve a workflow approval gate. ' +
      "For simple questions use type 'text'; for choices " +
      "use 'select' or 'multi-select' (with options).",
    parameters: AsyncAskHumanSchema,
    async execute(_toolCallId: string, params: AskParams): Promise<AgentToolResult<unknown>> {
      const questions = params.questions ?? []
      if (!questions.length) return errorResult('At least one question is required.')

      const items: QuestionItem[] = []
      const seen = new Set<string>()
      const errors: string[] = []
      for (const q of questions) {
        if (!q.id) {
          errors.push("Each question must have an 'id' field")
          continue
        }
        if (seen.has(q.id)) {
          errors.push(`Duplicate question id: '${q.id}'`)
          continue
        }
        seen.add(q.id)
        const type = q.type ?? 'text'
        if ((type === 'select' || type === 'multi-select') && !q.options?.length) {
          errors.push(`Question '${q.id}': options are required for ${type} questions`)
          continue
        }
        items.push({
          id: q.id,
          type,
          question: q.question,
          options: q.options,
          default: q.default,
          optional: q.optional,
        })
      }
      if (errors.length) return errorResult(errors.join('; '))

      const blocking = params.blocking === true
      await origin.flushPersistence()
      let record
      try {
        record = await dependencies.createQuestion(
          { agentId: origin.agentId, executionId: origin.executionId },
          { questions: items },
          { blocking, ...(params.waitScope ? { waitScope: params.waitScope } : {}) }
        )
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      const summary = items.map((q) => `"${q.question}"`).join(', ')
      const openedWaitWorkStreamIds = record.openedWaitWorkStreamIds
      const blockingNote = !blocking
        ? ''
        : openedWaitWorkStreamIds.length === 0
          ? ' No work-stream waits were opened.'
          : openedWaitWorkStreamIds.length === 1
            ? ` Opened a wait on 1 work stream: ${openedWaitWorkStreamIds[0]}.`
            : ` Opened waits on ${openedWaitWorkStreamIds.length} work streams: ${openedWaitWorkStreamIds.join(', ')}.`
      return {
        content: [
          {
            type: 'text' as const,
            text:
              record.audienceResolution === 'unroutable'
                ? `Question recorded (${record.id.slice(0, 8)}), but no direct Action Center recipient was found; the question is still visible and answerable by everyone who can read this agent.${blockingNote}`
                : `Question recorded (${record.id.slice(0, 8)}): ${summary}. The answer will arrive as an inbox message.${blockingNote}${blocking && openedWaitWorkStreamIds.length > 0 ? ' End your turn while the affected work waits; do not poll.' : ' You can continue other work in the meantime.'}`,
          },
        ],
        details: {
          questionId: record.id,
          async: true,
          blocking,
          openedWaitCount: openedWaitWorkStreamIds.length,
          openedWaitWorkStreamIds,
        },
      }
    },
  }
}
