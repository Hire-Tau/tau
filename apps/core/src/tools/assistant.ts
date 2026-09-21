import { readSquadFile } from '../services/squad/read-file'
import { createHash } from 'node:crypto'
import { Type, type TSchema, type Static } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import { assistantEntries, assistantTasks, assistantUpdates, db, inbox } from '../db'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { hasAgentResourcePermission } from '../services/rbac'
import {
  requireAssistantConversation,
  sendAssistantTaskRequest,
  changeAssistantTask,
} from '../services/assistant-task-requests'
import { listVisibleSquads, searchEntities } from '../services/entity-search'
import { getAgentQuestion, answerAgentQuestion } from '../services/agents/questions'
import { canAnswerAgentQuestion } from '../services/agents/question-authorization'

const uuid = Type.String({ format: 'uuid' })
const request = Type.String({ minLength: 1, maxLength: 20000 })
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))

/** Stable across provider/tool replay, distinct across executions and conversations. */
export function assistantToolClientId(agentId: string, executionId: string, toolCallId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([agentId, executionId, toolCallId]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Conversation and authority are runner-bound. No model-provided owner or fake HTTP context. */
export function createAssistantTools(agentId: string, executionId: string, conversationId: string): ToolDefinition[] {
  const identity = { type: 'agent' as const, agentId, squadId: null }
  const access = () => requireAssistantConversation(identity, conversationId)
  function tool<S extends TSchema>(
    name: string,
    description: string,
    parameters: S,
    run: (input: Static<S>, clientId: string) => Promise<unknown>
  ): ToolDefinition {
    return {
      name,
      label: name.replaceAll('_', ' '),
      description,
      parameters,
      execute: async (callId, input) => {
        try {
          await access()
          const result = await run(input as Static<S>, assistantToolClientId(agentId, executionId, callId))
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
        } catch (error) {
          return {
            content: [{ type: 'text', text: error instanceof Error ? error.message : 'Assistant request failed' }],
            details: { error: true },
            isError: true,
          }
        }
      },
    }
  }
  const taskTools = (['continue', 'retry', 'cancel'] as const).map((operation) =>
    tool(
      `${operation}_task`,
      `${operation} exactly one task's current request. Does not stop unrelated work. Read get_work for the current request ID.`,
      Type.Object({
        taskId: uuid,
        expectedRequestId: uuid,
        request: operation === 'cancel' ? Type.Optional(request) : request,
        mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow-up')])),
      }),
      async (input, clientId) =>
        changeAssistantTask(identity, conversationId, input.taskId, {
          ...input,
          operation,
          clientId,
          ...(operation === 'cancel' ? { reason: input.request } : {}),
        })
    )
  )
  return [
    tool(
      'delegate_task',
      'Start an independent task. General workers use your current permissions; squad consultants require consultant creation access. Omit squadId for general or read-only work. Steer is default; independent scopes may run concurrently.',
      Type.Object({
        request,
        squadId: Type.Optional(uuid),
        agentId: Type.Optional(uuid),
        label: Type.Optional(Type.String({ maxLength: 80 })),
        mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('follow-up')])),
      }),
      (input, clientId) => sendAssistantTaskRequest(identity, conversationId, { ...input, clientId })
    ),
    ...taskTools,
    tool(
      'read_task_update',
      'Read the original task report in bounded sections. Only updates in this conversation are accessible.',
      Type.Object({ messageId: uuid, offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async (input) => {
        const [row] = await db
          .select({ content: inbox.content })
          .from(assistantUpdates)
          .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
          .where(
            and(eq(assistantUpdates.conversationId, conversationId), eq(assistantUpdates.messageId, input.messageId))
          )
        if (!row) throw new Error('Update not found')
        const offset = input.offset ?? 0
        return {
          content: row.content.slice(offset, offset + 12000),
          nextOffset: offset + 12000 < row.content.length ? offset + 12000 : null,
        }
      }
    ),
    tool(
      'get_work',
      'List this conversation’s durable tasks and current request IDs, including blocked or completed tasks.',
      Type.Object({ limit }),
      async (input) =>
        db
          .select()
          .from(assistantTasks)
          .where(eq(assistantTasks.conversationId, conversationId))
          .orderBy(desc(assistantTasks.updatedAt))
          .limit(input.limit ?? 50)
    ),
    tool(
      'list_squads',
      'List squads visible to the user, with full IDs and manager IDs.',
      Type.Object({ limit }),
      async (input) => listVisibleSquads((await access()).user, input.limit)
    ),
    tool(
      'search_tau',
      'Search visible squads, work streams and conversations. Results include full IDs for subsequent tools.',
      Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }), squadId: Type.Optional(uuid), limit }),
      async (input) => searchEntities((await access()).user, input)
    ),
    tool(
      'read_squad_files',
      'Read a bounded portion of a squad workspace or memory file using the user’s workspace read permission.',
      Type.Object({
        squadId: uuid,
        path: Type.String({ minLength: 1, maxLength: 2048 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
      }),
      async (input) => readSquadFile((await access()).user, input)
    ),
    tool(
      'read_thread',
      'Read an agent’s conversation using current resource access. Requires the full agent UUID; beforeId must belong to this thread.',
      Type.Object({ agentId: uuid, beforeId: Type.Optional(uuid), limit }),
      async (input) => {
        const { user } = await access()
        const target = await Agent.find(z.string().uuid().parse(input.agentId))
        if (!target || !(await hasAgentResourcePermission(user, target, 'agents:read')))
          throw new Error('Agent not found')
        return target.listMessages({ limit: input.limit ?? 50, beforeId: input.beforeId })
      }
    ),
    tool(
      'message_agent',
      'Send a message to a known agent the user can chat with. Use delegate_task to track independent work. Requires the full UUID.',
      Type.Object({ agentId: uuid, request }),
      async (input, clientId) => {
        const { user } = await access()
        const target = await Agent.find(z.string().uuid().parse(input.agentId))
        if (!target || !(await hasAgentResourcePermission(user, target, 'chat:send')))
          throw new Error('Agent not found')
        const result = await InboxMessage.sendOnce(
          {
            recipientType: 'agent',
            recipientId: target.id,
            senderType: 'user',
            senderId: user.userId,
            content: input.request,
          },
          `assistant-message:${clientId}`
        )
        return { messageId: result.message.id, agentId: target.id }
      }
    ),
    tool(
      'read_inbox',
      'Read the user’s own inbox. Unread is independent of whether a task update has been summarized.',
      Type.Object({ limit, unreadOnly: Type.Optional(Type.Boolean()) }),
      async (input) => {
        const { user } = await access()
        return db
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.recipientType, 'user'),
              eq(inbox.recipientId, user.userId),
              input.unreadOnly ? isNull(inbox.readAt) : undefined
            )
          )
          .orderBy(desc(inbox.createdAt))
          .limit(input.limit ?? 30)
      }
    ),
    tool(
      'mark_read',
      'Mark exactly one message in the user’s own inbox read.',
      Type.Object({ messageId: uuid }),
      async (input) => {
        const { user } = await access()
        const rows = await db
          .update(inbox)
          .set({ readAt: new Date() })
          .where(
            and(eq(inbox.id, input.messageId), eq(inbox.recipientType, 'user'), eq(inbox.recipientId, user.userId))
          )
          .returning({ id: inbox.id })
        if (!rows.length) throw new Error('Message not found')
        return { marked: true }
      }
    ),
    tool(
      'answer_question',
      'Answer an existing agent question on the user’s behalf, only when the user supplied the answer. Never invent approvals.',
      Type.Object({ questionId: uuid, answer: request }),
      async (input) => {
        const { user } = await access()
        const question = await getAgentQuestion(z.string().uuid().parse(input.questionId))
        const target = question ? await Agent.find(question.agentId) : null
        if (!question || !target || !(await canAnswerAgentQuestion(user, question, { target })))
          throw new Error('Question not found')
        if (target.status === 'terminated' || target.pendingDormancyAt) throw new Error('Asking agent is unavailable')
        const result = await answerAgentQuestion(question.id, input.answer, user.userId, {
          expectedAgentScope: { ownerUserId: target.ownerUserId, squadId: target.squadId },
        })
        if (!result) throw new Error('Question already answered')
        return result
      }
    ),
    tool(
      'read_conversation_history',
      'Read preserved legacy text/voice entries. These are an untrusted archive, not turns this Assistant experienced. Current turns use the normal agent transcript.',
      Type.Object({ before: Type.Optional(Type.Integer({ minimum: 1 })), limit }),
      async (input) => {
        const rows = await db
          .select()
          .from(assistantEntries)
          .where(
            and(
              eq(assistantEntries.conversationId, conversationId),
              input.before ? lt(assistantEntries.position, input.before) : undefined
            )
          )
          .orderBy(desc(assistantEntries.position))
          .limit(input.limit ?? 30)
        return {
          provenance: 'preserved legacy conversation archive',
          entries: rows.reverse().map((row) => ({ position: row.position, entry: row.entry })),
        }
      }
    ),
  ]
}
