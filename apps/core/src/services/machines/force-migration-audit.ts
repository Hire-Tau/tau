import { and, eq } from 'drizzle-orm'
import { db, forcedBoxMigrationAudits } from '../../db'
import type { MigrateResult } from './box-migrate'
import type { DbTransaction } from './queries'

export const FORCE_MIGRATION_REASON_MAX_LENGTH = 500
export type ForceMigrationActor = { type: 'user' | 'agent'; id: string }
export type ForceMigrationOutcome = 'started' | 'succeeded' | 'failed' | 'canceled'
export type DbExecutor = typeof db | DbTransaction

export interface ForceMigrationAuditInput {
  requestId: string
  actor: ForceMigrationActor
  reason: string
  sandboxId: string
  squadId: string
  sourceMachineId: string
  targetMachineId: string
  activeExecutionCount: number
}

export type ForceMigrationAudit = typeof forcedBoxMigrationAudits.$inferSelect
export interface ForceMigrationTerminalState {
  outcome: Exclude<ForceMigrationOutcome, 'started'>
  result: MigrateResult | null
  failureCode: string | null
}
export type ForceMigrationSettlement =
  | { kind: 'settled'; audit: ForceMigrationAudit }
  | { kind: 'idempotent'; audit: ForceMigrationAudit }
  | { kind: 'conflict'; audit: ForceMigrationAudit; requested: ForceMigrationTerminalState }
  | { kind: 'missing'; id: string; requested: ForceMigrationTerminalState }

export function sameForceMigrationRequest(row: ForceMigrationAudit, input: ForceMigrationAuditInput): boolean {
  return (
    row.actorType === input.actor.type &&
    row.actorId === input.actor.id &&
    row.reason === input.reason.trim() &&
    row.sandboxId === input.sandboxId &&
    row.squadId === input.squadId &&
    row.sourceMachineId === input.sourceMachineId &&
    row.targetMachineId === input.targetMachineId &&
    row.activeExecutionCount === input.activeExecutionCount
  )
}

export async function findForceMigrationAudit(
  requestId: string,
  executor: DbExecutor = db
): Promise<ForceMigrationAudit | null> {
  const [row] = await executor
    .select()
    .from(forcedBoxMigrationAudits)
    .where(eq(forcedBoxMigrationAudits.requestId, requestId))
  return row ?? null
}

export async function startForceMigrationAudit(
  input: ForceMigrationAuditInput,
  executor: DbExecutor = db
): Promise<ForceMigrationAudit> {
  const reason = input.reason.trim()
  if (!reason || reason.length > FORCE_MIGRATION_REASON_MAX_LENGTH) throw new Error('Invalid forced migration reason')
  const normalized = { ...input, reason }
  const [created] = await executor
    .insert(forcedBoxMigrationAudits)
    .values({
      requestId: input.requestId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason,
      sandboxId: input.sandboxId,
      squadId: input.squadId,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
      activeExecutionCount: input.activeExecutionCount,
      outcome: 'started',
    })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const existing = await findForceMigrationAudit(input.requestId, executor)
  if (!existing || !sameForceMigrationRequest(existing, normalized))
    throw new Error('Forced migration request ID conflict')
  return existing
}

function sameResult(left: MigrateResult | null, right: MigrateResult | null): boolean {
  return (
    left?.moved === right?.moved &&
    (left?.reason ?? null) === (right?.reason ?? null) &&
    (left?.activeExecutionCount ?? null) === (right?.activeExecutionCount ?? null)
  )
}

async function finishWithExecutor(
  executor: DbExecutor,
  id: string,
  outcome: Exclude<ForceMigrationOutcome, 'started'>,
  result?: MigrateResult,
  failureCode?: string
): Promise<ForceMigrationSettlement> {
  const requested: ForceMigrationTerminalState = { outcome, result: result ?? null, failureCode: failureCode ?? null }
  const now = new Date()
  const [updated] = await executor
    .update(forcedBoxMigrationAudits)
    .set({ ...requested, completedAt: now, updatedAt: now })
    .where(and(eq(forcedBoxMigrationAudits.id, id), eq(forcedBoxMigrationAudits.outcome, 'started')))
    .returning()
  if (updated) return { kind: 'settled', audit: updated }
  const [existing] = await executor.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.id, id))
  if (!existing) return { kind: 'missing', id, requested }
  if (
    existing.outcome === requested.outcome &&
    existing.failureCode === requested.failureCode &&
    sameResult(existing.result as MigrateResult | null, requested.result)
  )
    return { kind: 'idempotent', audit: existing }
  return { kind: 'conflict', audit: existing, requested }
}

export class ForceMigrationAuditSettlementError extends Error {
  constructor(readonly settlement: Extract<ForceMigrationSettlement, { kind: 'conflict' | 'missing' }>) {
    super(`Forced migration audit settlement ${settlement.kind}`)
    this.name = 'ForceMigrationAuditSettlementError'
  }
}

export function requireForceMigrationSettlement(settlement: ForceMigrationSettlement): ForceMigrationAudit {
  if (settlement.kind === 'settled' || settlement.kind === 'idempotent') return settlement.audit
  throw new ForceMigrationAuditSettlementError(settlement)
}

export function finishForceMigrationAudit(
  id: string,
  outcome: Exclude<ForceMigrationOutcome, 'started'>,
  result?: MigrateResult,
  failureCode?: string
): Promise<ForceMigrationSettlement> {
  return finishWithExecutor(db, id, outcome, result, failureCode)
}

export function finishForceMigrationAuditInTransaction(
  tx: DbTransaction,
  id: string,
  result: MigrateResult
): Promise<ForceMigrationSettlement> {
  return finishWithExecutor(tx, id, 'succeeded', result)
}

/** API boot recovery: any still-started synchronous migration was interrupted. */
export async function cancelInterruptedForceMigrationAudits(): Promise<number> {
  const now = new Date()
  const rows = await db
    .update(forcedBoxMigrationAudits)
    .set({
      outcome: 'canceled',
      result: { moved: false, reason: 'failed' },
      failureCode: 'api-restart',
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(forcedBoxMigrationAudits.outcome, 'started'))
    .returning({ id: forcedBoxMigrationAudits.id })
  return rows.length
}
