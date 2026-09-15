import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import {
  assistantInboxRecipientId,
  isTerminalAssistantTaskStatus,
  reportableAssistantTaskStatusSchema,
  type AssistantTaskSummary,
} from '@tau/shared'
import { agents, assistantTasks, db } from '../db'
import { InboxMessage } from '../entities/InboxMessage'
import type { Identity } from '../services/rbac'

const uuid = z.string().uuid()
const statusSchema = z.object({
  status: reportableAssistantTaskStatusSchema,
  message: z.string().trim().min(1).max(20_000).optional(),
})

async function ownedTask(taskId: string, identity: Identity | undefined) {
  // Only the agent currently bound to the task may read or report on it. Anything else is 404
  // so task IDs cannot be probed across conversations or owners.
  if (!identity || identity.type !== 'agent' || !uuid.safeParse(taskId).success) return null
  const [row] = await db
    .select({ task: assistantTasks, agentStatus: agents.status })
    .from(assistantTasks)
    .leftJoin(agents, eq(agents.id, assistantTasks.agentId))
    .where(and(eq(assistantTasks.id, taskId), eq(assistantTasks.agentId, identity.agentId)))
  return row ?? null
}

function summarize(row: NonNullable<Awaited<ReturnType<typeof ownedTask>>>): AssistantTaskSummary {
  const { task, agentStatus } = row
  return {
    id: task.id,
    currentRequestId: task.currentRequestId,
    agentId: task.agentId,
    kind: task.kind,
    squadId: task.squadId,
    label: task.label,
    status: task.status,
    unavailable:
      !['completed', 'failed', 'cancelled'].includes(task.status) && (!agentStatus || agentStatus === 'terminated'),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

/**
 * Direct task status reporting for the delegated agent. `POST /:taskId/status` is sugar over an
 * inbox reply on the task's current request, so it goes through the same validation, projection,
 * activity events, and push policy as `tau inbox send --assistant-task-status`; the agent does
 * not need to track request IDs to keep the tracked status honest.
 */
export const assistantTasksRouter = new Hono()
  .get('/:taskId', async (c) => {
    const row = await ownedTask(c.req.param('taskId'), c.get('identity'))
    if (!row) return c.json({ error: 'Task not found' }, 404)
    c.set('authzChecked', true)
    return c.json(summarize(row))
  })
  .post('/:taskId/status', zValidator('json', statusSchema), async (c) => {
    const identity = c.get('identity') as Identity | undefined
    const row = await ownedTask(c.req.param('taskId'), identity)
    if (!row || identity?.type !== 'agent') return c.json({ error: 'Task not found' }, 404)
    c.set('authzChecked', true)
    const input = c.req.valid('json')
    // A finished task never reopens through a report; say so instead of recording a no-op update.
    // Only a new user follow-up in the conversation reopens it.
    if (isTerminalAssistantTaskStatus(row.task.status) && input.status !== row.task.status)
      return c.json(
        {
          error: `Task is already ${row.task.status}; reports cannot change a finished task. A new user follow-up reopens it.`,
          task: summarize(row),
        },
        409
      )
    const message = await InboxMessage.send({
      recipientType: 'voice_assistant',
      recipientId: assistantInboxRecipientId(row.task.conversationId),
      senderType: 'agent',
      senderId: identity.agentId,
      content: input.message ?? `Task status: ${input.status}`,
      metadata: { inReplyTo: row.task.currentRequestId },
      assistantTaskStatus: input.status,
    })
    const updated = await ownedTask(row.task.id, identity)
    return c.json({ task: updated ? summarize(updated) : summarize(row), messageId: message.id })
  })
