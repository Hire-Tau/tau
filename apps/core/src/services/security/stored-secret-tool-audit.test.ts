import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'bun:test'
import { db } from '../../db'
import { storedSecretToolAudits } from '../../db/schema'
import { recordStoredSecretToolAudit } from './stored-secret-tool-audit'

const executionsUsed = new Set<string>()

afterEach(async () => {
  for (const executionId of executionsUsed) {
    await db.delete(storedSecretToolAudits).where(eq(storedSecretToolAudits.executionId, executionId))
  }
  executionsUsed.clear()
})

describe('recordStoredSecretToolAudit', () => {
  test('persists exactly the four identity fields for a denied call', async () => {
    const agentId = randomUUID()
    const executionId = randomUUID()
    executionsUsed.add(executionId)
    const syntheticValue = `CANARY_SECRET_${randomUUID()}`

    await recordStoredSecretToolAudit({
      agentId,
      executionId,
      secretKey: 'SYNTHETIC_KEY',
      outcome: 'denied',
    })

    const rows = await db
      .select()
      .from(storedSecretToolAudits)
      .where(eq(storedSecretToolAudits.executionId, executionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentId, executionId, secretKey: 'SYNTHETIC_KEY', outcome: 'denied' })
    // The ledger row can never carry the value it detected; the synthetic
    // value is deliberately never passed to the writer at all.
    expect(JSON.stringify(rows)).not.toContain(syntheticValue)
    expect(Object.keys(rows[0]!).sort()).toEqual(['agentId', 'createdAt', 'executionId', 'id', 'outcome', 'secretKey'])
  })

  test('persists an already_executed outcome separately from denied', async () => {
    const agentId = randomUUID()
    const executionId = randomUUID()
    executionsUsed.add(executionId)

    await recordStoredSecretToolAudit({
      agentId,
      executionId,
      secretKey: 'SYNTHETIC_KEY',
      outcome: 'already_executed',
    })

    const [row] = await db
      .select()
      .from(storedSecretToolAudits)
      .where(eq(storedSecretToolAudits.executionId, executionId))
    expect(row?.outcome).toBe('already_executed')
  })

  test('the database rejects any other outcome label', async () => {
    const executionId = randomUUID()
    executionsUsed.add(executionId)

    await expect(
      (async () => {
        await db.insert(storedSecretToolAudits).values({
          agentId: randomUUID(),
          executionId,
          secretKey: 'SYNTHETIC_KEY',
          outcome: 'contained' as never,
        })
      })()
    ).rejects.toThrow()
  })
})
