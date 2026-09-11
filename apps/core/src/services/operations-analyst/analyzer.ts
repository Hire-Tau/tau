import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions, messages } from '../../db/schema'
import { getSecretStore } from '../secrets'
import { extractSignals } from './heuristics'
import { persistAnalysis } from './repository'
import type { TaintedInboxMessage, TaintedToolCall } from './types'

async function getKnownSecrets(): Promise<string[]> {
  const store = getSecretStore()
  return (await store.list())
    .filter((m) => m.isSet)
    .map((m) => store.get(m.key))
    .filter((v): v is string => typeof v === 'string' && v.length >= 4)
}
export async function analyzeExecution(
  executionId: string,
  deps: { getKnownSecrets?: () => Promise<string[]> } = {}
): Promise<'analyzed' | 'skipped' | 'already-analyzed'> {
  const row = (
    await db
      .select({ execution: executions, squadId: agents.squadId })
      .from(executions)
      .innerJoin(agents, eq(executions.agentId, agents.id))
      .where(eq(executions.id, executionId))
      .limit(1)
  )[0]
  if (!row) return 'skipped'
  const execution = row.execution
  if (execution.status !== 'completed') return 'skipped'
  const assistant = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.agentId, execution.agentId),
        eq(messages.role, 'assistant'),
        eq(sql`${messages.metadata}->>'executionId'`, execution.id)
      )
    )
  const inbox = execution.endedAt
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.agentId, execution.agentId),
            sql`${messages.metadata}->>'source' = 'inbox'`,
            sql`(${messages.metadata}->>'consumedAt')::timestamptz >= ${execution.startedAt.toISOString()}::timestamptz`,
            sql`(${messages.metadata}->>'consumedAt')::timestamptz <= ${execution.endedAt.toISOString()}::timestamptz`
          )
        )
    : []
  const tools: TaintedToolCall[] = []
  for (const message of assistant) {
    const metadata = message.metadata as { content?: unknown[] } | null
    for (const item of Array.isArray(metadata?.content) ? metadata.content : []) {
      const value = item as { type?: string; toolCall?: Record<string, unknown> }
      const call = value.type === 'tool_use' ? value.toolCall : undefined
      if (!call || typeof call.toolName !== 'string') continue
      tools.push({
        messageId: message.id,
        toolName: call.toolName,
        args: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
        result: typeof call.result === 'string' ? call.result : '',
        isError: call.isError === true,
        observedAt: message.createdAt,
      })
    }
  }
  const inboxMessages: TaintedInboxMessage[] = inbox.map((m) => ({
    messageId: m.id,
    content: m.content,
    consumedAt: new Date(String((m.metadata as { consumedAt: string }).consumedAt)),
  }))
  const signals = extractSignals({
    tools,
    inbox: inboxMessages,
    knownSecrets: await (deps.getKnownSecrets ?? getKnownSecrets)(),
  })
  const usage = execution.usage as { stats?: { tokens?: { total?: number } } } | null
  return persistAnalysis({
    executionId: execution.id,
    squadId: row.squadId,
    agentId: execution.agentId,
    signals,
    toolCallCount: tools.length,
    failedToolCallCount: tools.filter((t) => t.isError).length,
    durationMs: execution.endedAt ? Math.max(0, execution.endedAt.getTime() - execution.startedAt.getTime()) : 0,
    tokenCount: usage?.stats?.tokens?.total ?? 0,
  })
}
