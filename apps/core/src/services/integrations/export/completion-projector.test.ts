import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  agents,
  db,
  executions,
  integrationConnections,
  integrationExportConsents,
  integrationExportCursors,
  messages,
  squads,
  users,
} from '../../../db'
import { ExportCompletionProjector } from './completion-projector'

test('completed production-shaped assistant rows enqueue an export batch', async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `projector-${crypto.randomUUID()}@example.test` })
    .returning()
  const [squad] = await db.insert(squads).values({ name: 'Projector production shape', purpose: 'test' }).returning()
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
  const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'completed' }).returning()
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      squadId: squad.id,
      providerKey: 'bigbrain',
      adapterVersion: 1,
      displayName: 'Brain',
      configuration: { version: 1, apiBase: 'https://brain.example' },
      credentialRef: '__test:projector',
    })
    .returning()
  const [consent] = await db
    .insert(integrationExportConsents)
    .values({
      connectionId: connection.id,
      agentId: agent.id,
      consentedByUserId: user.id,
      adoptedEnqueueOrder: 0n,
    })
    .returning()
  await db.insert(integrationExportCursors).values({ consentId: consent.id, lastDeliveredEnqueueOrder: 0n })
  await db.insert(messages).values([
    {
      agentId: agent.id,
      role: 'human',
      content: 'question',
      pending: false,
      metadata: { source: 'user_chat', executionId: execution.id, sender: { userId: user.id } },
    },
    {
      agentId: agent.id,
      role: 'assistant',
      content: 'answer',
      pending: false,
      metadata: { executionId: execution.id, streamGroupId: `${execution.id}:${crypto.randomUUID()}:1` },
    },
  ])
  const enqueued: unknown[] = []
  const projector = new ExportCompletionProjector(
    {
      enqueue: async (input: unknown) => (
        enqueued.push(input),
        { idempotencyKey: 'id', recordCount: 2, byteCount: 10 }
      ),
    } as any,
    { record: async () => {} }
  )

  try {
    await projector.handle(execution.id)
    expect(enqueued).toHaveLength(1)
  } finally {
    await db.delete(integrationExportConsents).where(eq(integrationExportConsents.agentId, agent.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(executions).where(eq(executions.id, execution.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(users).where(eq(users.id, user.id))
  }
})
