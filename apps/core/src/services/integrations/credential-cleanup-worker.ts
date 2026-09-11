import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, integrationAuthorizationFlowReceipts, integrationCredentialCleanupJobs } from '../../db'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import type { SecretStoreTransaction } from '../secrets/store'

const log = createLogger('integration-credential-cleanup')
const LEASE_MS = 60_000
const MAX_BATCH = 10
const MAX_BACKOFF_MS = 15 * 60_000

export interface CredentialCleanupJob {
  id: string
  credentialRef: string
  authorizationFlowId: string | null
  attempts: number
  leaseToken: string
}

export interface IntegrationCredentialCleanupRepository {
  claim(now: Date, leaseExpiresAt: Date, leaseToken: string): Promise<CredentialCleanupJob | null>
  complete(id: string, leaseToken: string): Promise<void>
  settleWithinTransaction(job: CredentialCleanupJob, tx: SecretStoreTransaction): Promise<void>
  fail(id: string, leaseToken: string, attempts: number, nextAttemptAt: Date): Promise<void>
}

export class DbIntegrationCredentialCleanupRepository implements IntegrationCredentialCleanupRepository {
  constructor(private readonly eligibleCredentialRefs?: readonly string[]) {}
  async claim(_now: Date, _leaseExpiresAt: Date, leaseToken: string): Promise<CredentialCleanupJob | null> {
    return db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(integrationCredentialCleanupJobs)
        .where(
          and(
            lte(integrationCredentialCleanupJobs.nextAttemptAt, sql`clock_timestamp()`),
            or(
              isNull(integrationCredentialCleanupJobs.leaseToken),
              lte(integrationCredentialCleanupJobs.leaseExpiresAt, sql`clock_timestamp()`)
            ),
            this.eligibleCredentialRefs
              ? inArray(integrationCredentialCleanupJobs.credentialRef, [...this.eligibleCredentialRefs])
              : undefined
          )
        )
        .orderBy(asc(integrationCredentialCleanupJobs.nextAttemptAt), asc(integrationCredentialCleanupJobs.id))
        .for('update', { skipLocked: true })
        .limit(1)
      if (!job) return null
      await tx
        .update(integrationCredentialCleanupJobs)
        .set({
          leaseToken,
          leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(integrationCredentialCleanupJobs.id, job.id))
      return {
        id: job.id,
        credentialRef: job.credentialRef,
        authorizationFlowId: job.authorizationFlowId,
        attempts: job.attempts,
        leaseToken,
      }
    })
  }

  async complete(id: string, leaseToken: string): Promise<void> {
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(
        and(eq(integrationCredentialCleanupJobs.id, id), eq(integrationCredentialCleanupJobs.leaseToken, leaseToken))
      )
  }

  async settleWithinTransaction(job: CredentialCleanupJob, tx: SecretStoreTransaction): Promise<void> {
    const deleted = await tx
      .delete(integrationCredentialCleanupJobs)
      .where(
        and(
          eq(integrationCredentialCleanupJobs.id, job.id),
          eq(integrationCredentialCleanupJobs.leaseToken, job.leaseToken),
          gt(integrationCredentialCleanupJobs.leaseExpiresAt, sql`clock_timestamp()`)
        )
      )
      .returning({ id: integrationCredentialCleanupJobs.id })
    if (deleted.length !== 1) throw new Error('Credential cleanup lease lost')
    if (job.authorizationFlowId) {
      const settled = await tx
        .update(integrationAuthorizationFlowReceipts)
        .set({ cleanupSettledAt: sql`transaction_timestamp()`, updatedAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(integrationAuthorizationFlowReceipts.localFlowId, job.authorizationFlowId),
            eq(integrationAuthorizationFlowReceipts.artifactCredentialRef, job.credentialRef)
          )
        )
        .returning({ localFlowId: integrationAuthorizationFlowReceipts.localFlowId })
      if (settled.length !== 1) throw new Error('Credential cleanup receipt ownership lost')
    }
  }

  async fail(id: string, leaseToken: string, attempts: number, _nextAttemptAt: Date): Promise<void> {
    const delayMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 20), MAX_BACKOFF_MS)
    await db
      .update(integrationCredentialCleanupJobs)
      .set({
        attempts,
        nextAttemptAt: sql`clock_timestamp() + (${delayMs} * interval '1 millisecond')`,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'secret_delete_failed',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(eq(integrationCredentialCleanupJobs.id, id), eq(integrationCredentialCleanupJobs.leaseToken, leaseToken))
      )
  }
}

export class IntegrationCredentialCleanupWorker {
  #runner: PeriodicRunner | null = null

  constructor(
    private readonly repository: IntegrationCredentialCleanupRepository,
    private readonly credentials: {
      deleteWithDurableMutation(
        key: string,
        mutationBeforeDelete: (tx: SecretStoreTransaction) => Promise<void>
      ): Promise<void>
    },
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = () => crypto.randomUUID()
  ) {}

  async runOnce(): Promise<boolean> {
    const now = this.now()
    const token = this.uuid()
    const job = await this.repository.claim(now, new Date(now.getTime() + LEASE_MS), token)
    if (!job) return false
    try {
      await this.credentials.deleteWithDurableMutation(job.credentialRef, async (tx) => {
        await this.repository.settleWithinTransaction(job, tx)
      })
    } catch {
      const attempts = job.attempts + 1
      const backoffMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 20), MAX_BACKOFF_MS)
      await this.repository.fail(job.id, token, attempts, new Date(now.getTime() + backoffMs))
      log.warn('Credential cleanup retry scheduled', { jobId: job.id, attempts, code: 'secret_delete_failed' })
    }
    return true
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-credential-cleanup',
      intervalMs: 30_000,
      runImmediately: true,
      task: async () => {
        for (let i = 0; i < MAX_BATCH && (await this.runOnce()); i += 1) {
          // Drain only a bounded batch per tick.
        }
      },
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }
}
