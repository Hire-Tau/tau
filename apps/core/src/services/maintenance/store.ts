import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import {
  db,
  executionAdmissionReservations,
  executions,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
  k8sProvisionAttempts,
  machineBoxes,
  sandboxProvisionRecoveries,
} from '../../db'
import type { MaintenanceSnapshot } from './types'
import { restoreQueueOwnedAdmission } from '../execution/agent-admission'

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface LockedMaintenanceSnapshot {
  state: MaintenanceSnapshot
  databaseNow: Date
}
type StateRow = typeof instanceMaintenanceState.$inferSelect

export class MaintenanceLeaseConflict extends Error {
  constructor() {
    super('An active platform maintenance lease is owned by another caller')
    this.name = 'MaintenanceLeaseConflict'
  }
}

function snapshot(row: StateRow, databaseNow: Date): MaintenanceSnapshot {
  const now = new Date(databaseNow)
  const leaseActive = row.platformLeaseExpiresAt !== null && row.platformLeaseExpiresAt > now
  const effective = row.adminHold || leaseActive
  return {
    effective,
    phase: !effective ? 'active' : row.quiescedGeneration >= row.generation ? 'paused' : 'pausing',
    generation: row.generation,
    quiescedGeneration: row.quiescedGeneration,
    adminHold: {
      active: row.adminHold,
      reason: row.adminReason,
      heldAt: row.adminHeldAt?.toISOString() ?? null,
      heldBy: row.adminHeldBy,
    },
    platformLease: {
      active: leaseActive,
      leaseId: row.platformLeaseId,
      holder: row.platformLeaseHolder,
      acquiredAt: row.platformLeaseAcquiredAt?.toISOString() ?? null,
      expiresAt: row.platformLeaseExpiresAt?.toISOString() ?? null,
    },
  }
}

export class MaintenanceStore {
  private cached: MaintenanceSnapshot | null = null
  private listeners = new Set<(value: MaintenanceSnapshot) => void>()

  async initialize(): Promise<MaintenanceSnapshot> {
    await db.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
    return this.refresh()
  }

  async read(): Promise<MaintenanceSnapshot> {
    const [result] = await db
      .select({ state: instanceMaintenanceState, databaseNow: sql<Date>`clock_timestamp()` })
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    if (!result) throw new Error('Instance maintenance singleton is not initialized')
    return snapshot(result.state, result.databaseNow)
  }

  async refresh(): Promise<MaintenanceSnapshot> {
    const value = await this.read()
    this.updateCache(value)
    return value
  }

  cachedGeneration(): number {
    return this.cached?.generation ?? 0
  }

  isPausedCached(now = new Date()): boolean {
    if (!this.cached) return false
    return (
      this.cached.adminHold.active ||
      (this.cached.platformLease.expiresAt !== null && new Date(this.cached.platformLease.expiresAt) > now)
    )
  }

  onEffectiveChange(listener: (value: MaintenanceSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private updateCache(value: MaintenanceSnapshot): void {
    const changed = this.cached?.effective !== value.effective || this.cached?.generation !== value.generation
    this.cached = value
    if (changed) for (const listener of this.listeners) listener(value)
  }

  async setAdminHold(input: { active: boolean; reason?: string; actor: string }): Promise<MaintenanceSnapshot> {
    const value = await db.transaction(async (tx) => {
      const row = await this.lock(tx)
      const databaseNow = await this.clockInTx(tx)
      const old = snapshot(row, databaseNow)
      const generation = !old.effective && input.active ? row.generation + 1 : row.generation
      const [updated] = await tx
        .update(instanceMaintenanceState)
        .set({
          adminHold: input.active,
          adminReason: input.active ? (input.reason ?? null) : null,
          adminHeldAt: input.active ? databaseNow : null,
          adminHeldBy: input.active ? input.actor : null,
          generation,
          holderRevision: input.active !== row.adminHold ? row.holderRevision + 1n : row.holderRevision,
          updatedAt: databaseNow,
        })
        .where(eq(instanceMaintenanceState.id, 'global'))
        .returning()
      const current = snapshot(updated, databaseNow)
      if (input.active) {
        await tx
          .update(executionAdmissionReservations)
          .set({
            state: sql`CASE WHEN ${executionAdmissionReservations.state} IN ('queued', 'waiting-maintenance', 'provisional', 'requested', 'waiting') THEN 'revoked' ELSE 'revoking' END`,
            revokeGeneration: generation,
            revokeHolderRevision: updated.holderRevision,
            revokeAdminHold: updated.adminHold,
            revokeLeaseId: updated.platformLeaseId,
            revokeLeaseOwnerTokenId: updated.platformLeaseOwnerTokenId,
            revokeRequestedAt: databaseNow,
            updatedAt: databaseNow,
          })
          .where(sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`)
      }
      await this.audit(
        tx,
        current,
        input.active ? 'admin_acquired' : 'admin_released',
        input.actor,
        databaseNow,
        input.reason
      )
      return current
    })
    this.updateCache(value)
    return value
  }

  async acquireOrRenewLease(input: {
    leaseId: string
    ownerTokenId: string
    holder: string
    ttlSeconds: number
    actor: string
  }): Promise<MaintenanceSnapshot> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 120 || input.ttlSeconds > 600)
      throw new RangeError('ttlSeconds must be between 120 and 600')
    const value = await db.transaction(async (tx) => {
      const row = await this.lock(tx)
      const databaseNow = await this.clockInTx(tx)
      const old = snapshot(row, databaseNow)
      const same = row.platformLeaseId === input.leaseId && row.platformLeaseOwnerTokenId === input.ownerTokenId
      if (old.platformLease.active && !same) throw new MaintenanceLeaseConflict()
      const generation = !old.effective ? row.generation + 1 : row.generation
      const replacing = row.platformLeaseId !== null && !old.platformLease.active && !same
      const [updated] = await tx
        .update(instanceMaintenanceState)
        .set({
          platformLeaseId: input.leaseId,
          platformLeaseOwnerTokenId: input.ownerTokenId,
          platformLeaseHolder: input.holder,
          platformLeaseAcquiredAt: same ? row.platformLeaseAcquiredAt : databaseNow,
          platformLeaseExpiresAt: new Date(databaseNow.getTime() + input.ttlSeconds * 1_000),
          generation,
          holderRevision: same ? row.holderRevision : row.holderRevision + 1n,
          updatedAt: databaseNow,
        })
        .where(eq(instanceMaintenanceState.id, 'global'))
        .returning()
      const current = snapshot(updated, databaseNow)
      await this.audit(
        tx,
        current,
        replacing ? 'expired_lease_replaced' : same ? 'lease_renewed' : 'lease_acquired',
        input.actor,
        databaseNow
      )
      return current
    })
    this.updateCache(value)
    return value
  }

  async releaseLease(input: { leaseId: string; ownerTokenId: string; actor: string }): Promise<MaintenanceSnapshot> {
    const value = await db.transaction(async (tx) => {
      const row = await this.lock(tx)
      const databaseNow = await this.clockInTx(tx)
      if (row.platformLeaseId === null) return snapshot(row, databaseNow)
      if (row.platformLeaseId !== input.leaseId || row.platformLeaseOwnerTokenId !== input.ownerTokenId)
        throw new MaintenanceLeaseConflict()
      const [updated] = await tx
        .update(instanceMaintenanceState)
        .set({
          platformLeaseId: null,
          platformLeaseOwnerTokenId: null,
          platformLeaseHolder: null,
          platformLeaseAcquiredAt: null,
          platformLeaseExpiresAt: null,
          holderRevision: row.holderRevision + 1n,
          updatedAt: databaseNow,
        })
        .where(eq(instanceMaintenanceState.id, 'global'))
        .returning()
      const current = snapshot(updated, databaseNow)
      await this.audit(tx, current, 'lease_released', input.actor, databaseNow)
      return current
    })
    this.updateCache(value)
    return value
  }

  async readLocked(tx: DbTransaction): Promise<LockedMaintenanceSnapshot> {
    const row = await this.lock(tx, 'share')
    const databaseNow = await this.clockInTx(tx)
    return { state: snapshot(row, databaseNow), databaseNow }
  }

  async isPausedLocked(tx: DbTransaction): Promise<boolean> {
    return (await this.readLocked(tx)).state.effective
  }

  async isGenerationEffectiveLocked(tx: DbTransaction, generation: number): Promise<boolean> {
    const row = await this.lock(tx, 'share')
    const current = snapshot(row, await this.clockInTx(tx))
    return current.effective && current.generation === generation
  }

  async resumeWaitingExecutions(limit = 50): Promise<Array<{ id: string; agentId: string }>> {
    return db.transaction(async (tx) => {
      const { state } = await this.readLocked(tx)
      if (state.effective) return []

      const candidates = await tx
        .select({ id: executions.id, agentId: executions.agentId, generation: executions.maintenanceGeneration })
        .from(executions)
        .where(
          and(eq(executions.status, 'waiting-maintenance'), lte(executions.maintenanceGeneration, state.generation))
        )
        .orderBy(asc(executions.startedAt), asc(executions.id))
        .limit(limit)
        .for('update')
      if (!candidates.length) return []

      const resumed: Array<{ id: string; agentId: string }> = []
      for (const candidate of candidates) {
        if (candidate.generation === null) continue
        const [row] = await tx
          .update(executions)
          .set({ status: 'queued', maintenanceGeneration: null, maintenanceQueuedAt: null })
          .where(
            and(
              eq(executions.id, candidate.id),
              eq(executions.status, 'waiting-maintenance'),
              eq(executions.maintenanceGeneration, candidate.generation)
            )
          )
          .returning({ id: executions.id, agentId: executions.agentId })
        if (row) {
          if (!(await restoreQueueOwnedAdmission(tx, { agentId: row.agentId, executionId: row.id }))) {
            throw new Error('Maintenance resume lost its exact admission repair')
          }
          resumed.push(row)
        }
      }
      return resumed
    })
  }

  async acknowledgeQuiesced(generation: number, actor: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const row = await this.lock(tx)
      const databaseNow = await this.clockInTx(tx)
      const current = snapshot(row, databaseNow)
      if (!current.effective || row.generation !== generation) return false
      const [executionBlocker] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(inArray(executions.status, ['queued', 'waiting-sandbox', 'running', 'stopping']))
        .limit(1)
      if (executionBlocker) return false
      const [reservationBlocker] = await tx
        .select({ id: executionAdmissionReservations.executionId })
        .from(executionAdmissionReservations)
        .where(sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`)
        .limit(1)
      if (reservationBlocker) return false
      const [recoveryBlocker] = await tx
        .select({ id: sandboxProvisionRecoveries.executionId })
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.status, 'leased'))
        .limit(1)
      if (recoveryBlocker) return false
      const [provisionBlocker] = await tx
        .select({ id: k8sProvisionAttempts.attemptId })
        .from(k8sProvisionAttempts)
        .where(eq(k8sProvisionAttempts.status, 'in_progress'))
        .limit(1)
      if (provisionBlocker) return false
      const [boxBlocker] = await tx
        .select({ id: machineBoxes.sandboxId })
        .from(machineBoxes)
        .where(sql`${machineBoxes.status} = 'ensuring' OR ${machineBoxes.migrating} = true`)
        .limit(1)
      if (boxBlocker) return false
      await tx
        .update(instanceMaintenanceState)
        .set({ quiescedGeneration: generation, updatedAt: databaseNow })
        .where(and(eq(instanceMaintenanceState.id, 'global'), eq(instanceMaintenanceState.generation, generation)))
      const next = { ...current, quiescedGeneration: generation, phase: 'paused' as const }
      await this.audit(tx, next, 'worker_quiesced', actor, databaseNow)
      this.updateCache(next)
      return true
    })
  }

  private async lock(tx: DbTransaction, mode: 'update' | 'share' = 'update'): Promise<StateRow> {
    // The API/worker initialize eagerly; keeping this idempotent guard here also
    // makes test-only direct claim paths and rolling upgrades fail safe.
    await tx.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
    await tx.execute(
      mode === 'update'
        ? sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR UPDATE`
        : sql`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR SHARE`
    )
    const [row] = await tx.select().from(instanceMaintenanceState).where(eq(instanceMaintenanceState.id, 'global'))
    if (!row) throw new Error('Instance maintenance singleton is not initialized')
    return row
  }

  private async clockInTx(tx: DbTransaction): Promise<Date> {
    const [clock] = await tx
      .select({ now: sql<Date>`clock_timestamp()` })
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    if (!clock) throw new Error('Instance maintenance singleton is not initialized')
    return new Date(clock.now)
  }

  private async audit(
    tx: DbTransaction,
    value: MaintenanceSnapshot,
    action: string,
    actor: string,
    databaseNow: Date,
    reason?: string
  ): Promise<void> {
    await tx.insert(instanceMaintenanceAudit).values({
      generation: value.generation,
      action,
      actor,
      reason: reason ?? null,
      leaseId: value.platformLease.leaseId,
      leaseExpiresAt: value.platformLease.expiresAt ? new Date(value.platformLease.expiresAt) : null,
      adminHold: value.adminHold.active,
      effective: value.effective,
      createdAt: databaseNow,
    })
  }
}

export const maintenanceStore = new MaintenanceStore()
