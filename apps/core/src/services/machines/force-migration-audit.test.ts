import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, forcedBoxMigrationAudits } from '../../db'
import { finishForceMigrationAudit, startForceMigrationAudit } from './force-migration-audit'

const requestIds: string[] = []
afterEach(async () => {
  for (const id of requestIds.splice(0))
    await db.delete(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, id))
})

const input = () => {
  const requestId = crypto.randomUUID()
  requestIds.push(requestId)
  return {
    requestId,
    actor: { type: 'user' as const, id: crypto.randomUUID() },
    reason: 'Evacuate failing host',
    sandboxId: `squad_${crypto.randomUUID()}`,
    squadId: crypto.randomUUID(),
    sourceMachineId: crypto.randomUUID(),
    targetMachineId: crypto.randomUUID(),
    activeExecutionCount: 2,
  }
}

describe('forced migration audit repository', () => {
  test('durably records bounded actor/reason/count and a terminal outcome', async () => {
    const started = await startForceMigrationAudit(input())
    expect(started).toMatchObject({
      actorType: 'user',
      reason: 'Evacuate failing host',
      activeExecutionCount: 2,
      outcome: 'started',
    })
    await finishForceMigrationAudit(started.id, 'failed', { moved: false, reason: 'restore-failed' }, 'restore-failed')
    const [stored] = await db.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.id, started.id))
    expect(stored).toMatchObject({
      outcome: 'failed',
      failureCode: 'restore-failed',
      result: { moved: false, reason: 'restore-failed' },
    })
  })

  test('classifies first, equivalent, conflicting, and missing settlements', async () => {
    const started = await startForceMigrationAudit(input())
    const result = { moved: false as const, reason: 'restore-failed' as const }
    expect(await finishForceMigrationAudit(started.id, 'failed', result, 'restore-failed')).toMatchObject({
      kind: 'settled',
    })
    const firstCompletedAt = (
      await db.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.id, started.id))
    )[0]!.completedAt
    expect(await finishForceMigrationAudit(started.id, 'failed', result, 'restore-failed')).toMatchObject({
      kind: 'idempotent',
    })
    expect(await finishForceMigrationAudit(started.id, 'canceled', result, 'canceled')).toMatchObject({
      kind: 'conflict',
      audit: { outcome: 'failed' },
    })
    expect(await finishForceMigrationAudit(crypto.randomUUID(), 'failed', result, 'restore-failed')).toMatchObject({
      kind: 'missing',
    })
    const stored = (
      await db.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.id, started.id))
    )[0]!
    expect(stored.completedAt).toEqual(firstCompletedAt)
    expect(stored.outcome).toBe('failed')
  })

  test('allows exactly one concurrent terminal writer and exposes the winner', async () => {
    const started = await startForceMigrationAudit(input())
    const [failed, canceled] = await Promise.all([
      finishForceMigrationAudit(started.id, 'failed', { moved: false, reason: 'restore-failed' }, 'restore-failed'),
      finishForceMigrationAudit(started.id, 'canceled', { moved: false, reason: 'failed' }, 'canceled'),
    ])
    expect([failed.kind, canceled.kind].sort()).toEqual(['conflict', 'settled'])
    const winner = failed.kind === 'settled' ? failed.audit : canceled.kind === 'settled' ? canceled.audit : null
    const stored = (
      await db.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.id, started.id))
    )[0]
    expect(stored).toMatchObject({ outcome: winner!.outcome, result: winner!.result, failureCode: winner!.failureCode })
  })

  test('classifies an equivalent concurrent retry as idempotent', async () => {
    const started = await startForceMigrationAudit(input())
    const settle = () =>
      finishForceMigrationAudit(started.id, 'failed', { moved: false, reason: 'restore-failed' }, 'restore-failed')
    const outcomes = await Promise.all([settle(), settle()])
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['idempotent', 'settled'])
  })

  test('is idempotent for identical request IDs and rejects parameter spoofing', async () => {
    const request = input()
    const first = await startForceMigrationAudit(request)
    expect((await startForceMigrationAudit(request)).id).toBe(first.id)
    const mismatches = [
      { ...request, actor: { ...request.actor, type: 'agent' as const } },
      { ...request, actor: { ...request.actor, id: crypto.randomUUID() } },
      { ...request, reason: 'Different reason' },
      { ...request, sandboxId: `squad_${crypto.randomUUID()}` },
      { ...request, squadId: crypto.randomUUID() },
      { ...request, sourceMachineId: crypto.randomUUID() },
      { ...request, targetMachineId: crypto.randomUUID() },
      { ...request, activeExecutionCount: request.activeExecutionCount + 1 },
    ]
    for (const mismatch of mismatches)
      await expect(startForceMigrationAudit(mismatch)).rejects.toThrow('request ID conflict')
  })

  test('rejects empty and overlong reasons before persistence', async () => {
    await expect(startForceMigrationAudit({ ...input(), reason: '  ' })).rejects.toThrow('Invalid')
    await expect(startForceMigrationAudit({ ...input(), reason: 'x'.repeat(501) })).rejects.toThrow('Invalid')
  })
})
