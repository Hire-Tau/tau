import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  agents,
  db,
  executions,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
  messages,
  chatSendReceipts,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { MaintenanceStore } from './store'

let releaseIsolation: (() => Promise<void>) | undefined
const store = new MaintenanceStore()

beforeAll(async () => {
  releaseIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => releaseIsolation?.())
beforeEach(async () => {
  await db.delete(instanceMaintenanceAudit)
  await db.delete(instanceMaintenanceState)
  await store.initialize()
})
afterEach(async () => {
  await db.delete(chatSendReceipts)
  await db.delete(messages)
  await db.delete(executions)
  await db.delete(agents)
  await db.delete(instanceMaintenanceAudit)
  await db.delete(instanceMaintenanceState)
})

describe('maintenance chat acceptance', () => {
  test('atomically persists the pending turn as maintenance-waiting using the current generation', async () => {
    const [row] = await db.insert(agents).values({ agentTypeId: 'worker', status: 'idle' }).returning()
    const agent = await Agent.mustFind(row.id)
    const paused = await store.setAdminHold({ active: true, actor: 'test' })

    const result = await agent.sendMessage('keep this turn', { metadata: { clientId: 'maintenance-turn' } })

    expect(result.status).toBe('waiting-maintenance')
    const [execution] = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(execution.status).toBe('waiting-maintenance')
    expect(execution.maintenanceGeneration).toBe(paused.generation)
    expect(execution.maintenanceQueuedAt).toBeInstanceOf(Date)
    const persisted = await db.select().from(messages).where(eq(messages.agentId, agent.id))
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.pending).toBe(true)
  })
})
