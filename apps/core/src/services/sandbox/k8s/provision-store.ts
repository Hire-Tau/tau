import { createHash, randomUUID } from 'crypto'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import { db as defaultDb } from '../../../db'
import { k8sProvisionAttempts, k8sProvisionControls } from '../../../db/schema'
import type { ProvisionConfig } from './provision-config'
import { provisionConfig } from './provision-config'
import { SandboxProvisionError } from './provision-errors'
import { createLogger } from '../../../lib/infra/logger'
import type { ProvisionFailureCode } from './provision-failure'

const log = createLogger('k8s-provision-store')

export function safeCoordinationErrorMetadata(error: unknown): { name: string; code?: string } {
  const value = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {}
  const name = typeof value.name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value.name) ? value.name : 'Error'
  const code =
    (typeof value.code === 'string' || typeof value.code === 'number') &&
    /^[A-Za-z0-9_.-]{1,40}$/.test(String(value.code))
      ? String(value.code)
      : undefined
  return { name, ...(code ? { code } : {}) }
}

type Database = typeof defaultDb
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type ProvisionControlRow = typeof k8sProvisionControls.$inferSelect
export type OperationKind = 'ensure' | 'recreate'

export interface ClaimInput {
  scope: string
  sandboxKey: string
  operationKind: OperationKind
  desiredSpecHash: string
  ownerId: string
}
export interface OwnedAttempt extends ClaimInput {
  attemptId: string
  leaseExpiresAt: Date
  probe: boolean
}
export interface ProvisionTransition {
  from: 'closed' | 'open' | 'half_open'
  to: 'closed' | 'open' | 'half_open'
  version: number
  reasonCode?: ProvisionFailureCode
  retryAfterMs?: number
  inFlight: number
}
export type ClaimResult =
  | { kind: 'owner'; attempt: OwnedAttempt; controlVersion?: number; transition?: ProvisionTransition }
  | { kind: 'join'; attempt: OwnedAttempt; controlVersion?: number }
  | { kind: 'busy'; attempt?: OwnedAttempt; retryAfterMs: number; controlVersion?: number }
  | { kind: 'open'; retryAfterMs: number; reasonCode?: ProvisionFailureCode; controlVersion?: number }
export type CompletionInput =
  | { attempt: OwnedAttempt; kind: 'success'; podName: string; resultSpecHash: string }
  | { attempt: OwnedAttempt; kind: 'failure'; failureCode: ProvisionFailureCode }
export interface CompletionResult {
  accepted: boolean
  controlVersion?: number
  transition?: ProvisionTransition
}
export interface ObservedAttempt {
  status: string
  podName?: string
  resultSpecHash?: string
  failureCode?: ProvisionFailureCode
}

export interface ProvisionStore {
  claim(input: ClaimInput): Promise<ClaimResult>
  heartbeat(input: OwnedAttempt): Promise<boolean>
  complete(input: CompletionInput): Promise<CompletionResult>
  observe(input: OwnedAttempt): Promise<ObservedAttempt | null>
  cancelOwned(ownerId: string): Promise<void>
  diagnostics(scope: string): Promise<{
    state: string
    inFlight: number
    reasonCode?: string
    retryAfterMs?: number
    recentFailureCount?: number
    version?: number
  }>
}

const LEASE_MS = 30_000
const BUSY_RETRY_MS = 5_000

export function provisionScope(server: string, namespace: string): string {
  return createHash('sha256').update(server).update('\0').update(namespace).digest('hex')
}

export class PostgresProvisionStore implements ProvisionStore {
  private readonly db: Database
  private readonly config: ProvisionConfig
  private readonly clock: () => number
  private readonly onCoordinationError: (metadata: { name: string; code?: string }) => void
  private nextCoordinationErrorLogAt = 0
  constructor(
    options: {
      db?: Database
      config?: ProvisionConfig
      clock?: () => number
      onCoordinationError?: (metadata: { name: string; code?: string }) => void
    } = {}
  ) {
    this.db = options.db ?? defaultDb
    this.config = options.config ?? provisionConfig
    this.clock = options.clock ?? Date.now
    this.onCoordinationError =
      options.onCoordinationError ??
      ((metadata) => log.error('Kubernetes provisioning coordination dependency failed', metadata))
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(k8sProvisionControls).values({ scope: input.scope }).onConflictDoNothing()
        const [control] = await tx
          .select()
          .from(k8sProvisionControls)
          .where(eq(k8sProvisionControls.scope, input.scope))
          .for('update')
        if (!control) throw new Error('coordination control missing')
        const now = new Date(this.clock())
        await tx.execute(sql`
          DELETE FROM ${k8sProvisionAttempts}
          WHERE scope = ${input.scope}
            AND (
              (status = 'in_progress' AND lease_expires_at <= ${now.toISOString()} AND attempt_id IS DISTINCT FROM ${control.probeAttemptId})
              OR (status <> 'in_progress' AND completed_at < ${new Date(now.getTime() - 30_000).toISOString()})
            )
        `)
        await tx.execute(sql`
          DELETE FROM ${k8sProvisionAttempts}
          WHERE (scope, sandbox_key) IN (
            SELECT scope, sandbox_key
            FROM ${k8sProvisionAttempts}
            WHERE scope = ${input.scope} AND status <> 'in_progress'
            ORDER BY completed_at DESC NULLS LAST, sandbox_key DESC
            OFFSET 127
          )
        `)
        if (control.state === 'open' && control.retryAt && control.retryAt > now) {
          return {
            kind: 'open' as const,
            retryAfterMs: control.retryAt.getTime() - now.getTime(),
            reasonCode: control.reasonCode as ProvisionFailureCode | undefined,
            controlVersion: control.version,
          }
        }
        if (control.state === 'half_open') {
          const reconciled = await this.reconcileHalfOpenInTransaction(tx, control, now)
          return {
            kind: 'open' as const,
            retryAfterMs: reconciled.retryAfterMs,
            reasonCode: control.reasonCode as ProvisionFailureCode | undefined,
            controlVersion: reconciled.controlVersion,
          }
        }

        const [existing] = await tx
          .select()
          .from(k8sProvisionAttempts)
          .where(
            and(eq(k8sProvisionAttempts.scope, input.scope), eq(k8sProvisionAttempts.sandboxKey, input.sandboxKey))
          )
          .for('update')
        if (existing?.status === 'in_progress' && existing.leaseExpiresAt > now) {
          const operationCompatible = input.operationKind === 'ensure' || existing.operationKind === 'recreate'
          const compatible = operationCompatible && existing.desiredSpecHash === input.desiredSpecHash
          const attempt = this.rowToAttempt(existing)
          return compatible
            ? { kind: 'join' as const, attempt, controlVersion: control.version }
            : { kind: 'busy' as const, attempt, retryAfterMs: BUSY_RETRY_MS, controlVersion: control.version }
        }

        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(k8sProvisionAttempts)
          .where(
            and(
              eq(k8sProvisionAttempts.scope, input.scope),
              eq(k8sProvisionAttempts.status, 'in_progress'),
              gt(k8sProvisionAttempts.leaseExpiresAt, now),
              ne(k8sProvisionAttempts.sandboxKey, input.sandboxKey)
            )
          )
        if (count >= this.config.maxConcurrent)
          return { kind: 'busy' as const, retryAfterMs: BUSY_RETRY_MS, controlVersion: control.version }

        const attempt: OwnedAttempt = {
          ...input,
          attemptId: randomUUID(),
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          probe: control.state === 'open',
        }
        await tx
          .insert(k8sProvisionAttempts)
          .values({ ...attempt, status: 'in_progress' })
          .onConflictDoUpdate({
            target: [k8sProvisionAttempts.scope, k8sProvisionAttempts.sandboxKey],
            set: {
              operationKind: attempt.operationKind,
              desiredSpecHash: attempt.desiredSpecHash,
              attemptId: attempt.attemptId,
              ownerId: attempt.ownerId,
              status: 'in_progress',
              leaseExpiresAt: attempt.leaseExpiresAt,
              podName: null,
              resultSpecHash: null,
              failureCode: null,
              completedAt: null,
              updatedAt: now,
            },
          })
        if (attempt.probe) {
          await tx
            .update(k8sProvisionControls)
            .set({
              state: 'half_open',
              probeAttemptId: attempt.attemptId,
              retryAt: null,
              version: control.version + 1,
              updatedAt: now,
            })
            .where(eq(k8sProvisionControls.scope, input.scope))
        }
        return {
          kind: 'owner' as const,
          attempt,
          controlVersion: attempt.probe ? control.version + 1 : control.version,
          transition: attempt.probe
            ? {
                from: 'open' as const,
                to: 'half_open' as const,
                version: control.version + 1,
                reasonCode: control.reasonCode as ProvisionFailureCode | undefined,
                inFlight: count + 1,
              }
            : undefined,
        }
      })
    } catch (error) {
      const now = this.clock()
      if (now >= this.nextCoordinationErrorLogAt) {
        this.nextCoordinationErrorLogAt = now + 30_000
        this.onCoordinationError(safeCoordinationErrorMetadata(error))
      }
      throw new SandboxProvisionError(
        'SANDBOX_PROVISION_COORDINATION_UNAVAILABLE',
        'Sandbox provisioning coordination is temporarily unavailable.',
        BUSY_RETRY_MS
      )
    }
  }

  async reconcileExpiredHalfOpenProbe(scope: string, now: Date = new Date()): Promise<ProvisionTransition | null> {
    return this.db.transaction(async (tx) => {
      const [control] = await tx
        .select()
        .from(k8sProvisionControls)
        .where(eq(k8sProvisionControls.scope, scope))
        .for('update')
      if (!control || control.state !== 'half_open') return null
      const result = await this.reconcileHalfOpenInTransaction(tx, control, now)
      if (!result.reopened) return null
      const [{ count: inFlight }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(k8sProvisionAttempts)
        .where(
          and(
            eq(k8sProvisionAttempts.scope, scope),
            eq(k8sProvisionAttempts.status, 'in_progress'),
            gt(k8sProvisionAttempts.leaseExpiresAt, now)
          )
        )
      return {
        from: 'half_open',
        to: 'open',
        version: result.controlVersion,
        reasonCode: control.reasonCode as ProvisionFailureCode | undefined,
        retryAfterMs: result.retryAfterMs,
        inFlight,
      }
    })
  }

  private async reconcileHalfOpenInTransaction(
    tx: DbTransaction,
    control: ProvisionControlRow,
    now: Date
  ): Promise<{ reopened: boolean; retryAfterMs: number; controlVersion: number }> {
    const [probe] = control.probeAttemptId
      ? await tx
          .select()
          .from(k8sProvisionAttempts)
          .where(eq(k8sProvisionAttempts.attemptId, control.probeAttemptId))
          .for('update')
      : []
    if (probe?.status === 'in_progress' && probe.leaseExpiresAt > now) {
      return {
        reopened: false,
        retryAfterMs: Math.max(1, probe.leaseExpiresAt.getTime() - now.getTime()),
        controlVersion: control.version,
      }
    }
    if (probe?.status === 'in_progress') {
      await tx
        .update(k8sProvisionAttempts)
        .set({ status: 'cancelled', failureCode: 'cancelled', completedAt: now, updatedAt: now })
        .where(and(eq(k8sProvisionAttempts.attemptId, probe.attemptId), eq(k8sProvisionAttempts.status, 'in_progress')))
    }
    await tx
      .update(k8sProvisionControls)
      .set({
        state: 'open',
        retryAt: new Date(now.getTime() + this.config.cooldownMs),
        probeAttemptId: null,
        version: control.version + 1,
        updatedAt: now,
      })
      .where(and(eq(k8sProvisionControls.scope, control.scope), eq(k8sProvisionControls.version, control.version)))
    return { reopened: true, retryAfterMs: this.config.cooldownMs, controlVersion: control.version + 1 }
  }

  async heartbeat(input: OwnedAttempt): Promise<boolean> {
    const rows = await this.db
      .update(k8sProvisionAttempts)
      .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
      .where(and(eq(k8sProvisionAttempts.attemptId, input.attemptId), eq(k8sProvisionAttempts.status, 'in_progress')))
      .returning({ attemptId: k8sProvisionAttempts.attemptId })
    return rows.length === 1
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    return this.db.transaction(async (tx) => {
      const now = new Date(this.clock())
      const success = input.kind === 'success'
      const rows = await tx
        .update(k8sProvisionAttempts)
        .set({
          status: success ? 'succeeded' : 'failed',
          podName: success ? input.podName : null,
          resultSpecHash: success ? input.resultSpecHash : null,
          failureCode: success ? null : input.failureCode,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(k8sProvisionAttempts.attemptId, input.attempt.attemptId),
            eq(k8sProvisionAttempts.status, 'in_progress')
          )
        )
        .returning({ attemptId: k8sProvisionAttempts.attemptId })
      if (rows.length !== 1) return { accepted: false }

      const [control] = await tx
        .select()
        .from(k8sProvisionControls)
        .where(eq(k8sProvisionControls.scope, input.attempt.scope))
        .for('update')
      if (!control) return { accepted: true }
      let transition: ProvisionTransition | undefined
      if (success && control.state === 'half_open' && control.probeAttemptId === input.attempt.attemptId) {
        await tx
          .update(k8sProvisionControls)
          .set({
            state: 'closed',
            failures: [],
            reasonCode: null,
            retryAt: null,
            probeAttemptId: null,
            version: control.version + 1,
            updatedAt: now,
          })
          .where(eq(k8sProvisionControls.scope, input.attempt.scope))
        const [{ count: inFlight }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(k8sProvisionAttempts)
          .where(
            and(
              eq(k8sProvisionAttempts.scope, input.attempt.scope),
              eq(k8sProvisionAttempts.status, 'in_progress'),
              gt(k8sProvisionAttempts.leaseExpiresAt, now)
            )
          )
        transition = { from: 'half_open', to: 'closed', version: control.version + 1, inFlight }
      } else if (!success) {
        const certain = [
          'control_plane_unavailable',
          'control_plane_throttled',
          'control_plane_error',
          'cluster_authorization',
        ].includes(input.failureCode)
        const correlated = ['unschedulable_capacity', 'storage_substrate'].includes(input.failureCode)
        if (certain || correlated) {
          type StoredFailure = { at: number; sandboxKey: string; code: ProvisionFailureCode; correlated: boolean }
          const previous = Array.isArray(control.failures) ? (control.failures as StoredFailure[]) : []
          const failures = [
            ...previous.filter((failure) => failure.at >= now.getTime() - this.config.failureWindowMs),
            {
              at: now.getTime(),
              sandboxKey: input.attempt.sandboxKey,
              code: input.failureCode,
              correlated,
            },
          ].slice(-this.config.failureThreshold)
          const distinct = new Set(
            failures.filter((failure) => failure.correlated).map((failure) => failure.sandboxKey)
          ).size
          const shouldOpen =
            control.state === 'half_open' ||
            failures.filter((failure) => !failure.correlated).length >= this.config.failureThreshold ||
            (failures.filter((failure) => failure.correlated).length >= this.config.failureThreshold && distinct >= 2)
          const didTransition = shouldOpen && control.state !== 'open'
          await tx
            .update(k8sProvisionControls)
            .set({
              failures,
              state: didTransition ? 'open' : control.state,
              reasonCode: didTransition ? input.failureCode : control.reasonCode,
              retryAt: didTransition ? new Date(now.getTime() + this.config.cooldownMs) : control.retryAt,
              probeAttemptId: didTransition ? null : control.probeAttemptId,
              version: didTransition ? control.version + 1 : control.version,
              updatedAt: now,
            })
            .where(eq(k8sProvisionControls.scope, input.attempt.scope))
          if (didTransition) {
            const [{ count: inFlight }] = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(k8sProvisionAttempts)
              .where(
                and(
                  eq(k8sProvisionAttempts.scope, input.attempt.scope),
                  eq(k8sProvisionAttempts.status, 'in_progress'),
                  gt(k8sProvisionAttempts.leaseExpiresAt, now)
                )
              )
            transition = {
              from: control.state as 'closed' | 'half_open',
              to: 'open',
              version: control.version + 1,
              reasonCode: input.failureCode,
              retryAfterMs: this.config.cooldownMs,
              inFlight,
            }
          }
        }
      }
      return {
        accepted: true,
        controlVersion: transition?.version ?? control.version,
        transition,
      }
    })
  }

  async observe(input: OwnedAttempt): Promise<ObservedAttempt | null> {
    const [row] = await this.db
      .select()
      .from(k8sProvisionAttempts)
      .where(eq(k8sProvisionAttempts.attemptId, input.attemptId))
    return row
      ? {
          status: row.status,
          podName: row.podName ?? undefined,
          resultSpecHash: row.resultSpecHash ?? undefined,
          failureCode: row.failureCode as ProvisionFailureCode | undefined,
        }
      : null
  }

  async cancelOwned(ownerId: string): Promise<void> {
    await this.db
      .update(k8sProvisionAttempts)
      .set({ status: 'cancelled', failureCode: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(k8sProvisionAttempts.ownerId, ownerId), eq(k8sProvisionAttempts.status, 'in_progress')))
  }

  async diagnostics(scope: string) {
    const [control] = await this.db.select().from(k8sProvisionControls).where(eq(k8sProvisionControls.scope, scope))
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(k8sProvisionAttempts)
      .where(and(eq(k8sProvisionAttempts.scope, scope), eq(k8sProvisionAttempts.status, 'in_progress')))
    return {
      state: control?.state ?? 'closed',
      inFlight: count,
      reasonCode: control?.reasonCode ?? undefined,
      retryAfterMs: control?.retryAt ? Math.max(0, control.retryAt.getTime() - Date.now()) : undefined,
      recentFailureCount: Array.isArray(control?.failures) ? control.failures.length : 0,
      version: control?.version ?? 0,
    }
  }

  private rowToAttempt(row: typeof k8sProvisionAttempts.$inferSelect): OwnedAttempt {
    return {
      scope: row.scope,
      sandboxKey: row.sandboxKey,
      operationKind: row.operationKind as OperationKind,
      desiredSpecHash: row.desiredSpecHash,
      attemptId: row.attemptId,
      ownerId: row.ownerId,
      leaseExpiresAt: row.leaseExpiresAt,
      probe: false,
    }
  }
}
