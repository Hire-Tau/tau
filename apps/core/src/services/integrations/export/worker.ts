import type { ExportBatchRecord, ExportOutbox, ExportOutboxRepository } from './outbox'

const MAX_ATTEMPTS = 8
export type ExportDeliveryResult =
  | { ok: true }
  | { ok: false; code: string; retryable: boolean; retryAfterMs?: number }
  | { ok: false; code: string; gated: true; permanent: boolean }

export interface ExportWorkerDependencies {
  repository: ExportOutboxRepository
  outbox: ExportOutbox
  recheck(batch: ExportBatchRecord): Promise<{ allowed: true } | { allowed: false; code: string; permanent: boolean }>
  deliver(batch: ExportBatchRecord, plaintext: Uint8Array): Promise<ExportDeliveryResult>
  now?: () => Date
  uuid?: () => string
}

export class IntegrationExportWorker {
  readonly #now: () => Date
  readonly #uuid: () => string
  constructor(private readonly dependencies: ExportWorkerDependencies) {
    this.#now = dependencies.now ?? (() => new Date())
    // Wrap, not bare: `crypto.randomUUID` called unbound (this.#uuid()) throws
    // ERR_INVALID_THIS ("Expected this to be instanceof Crypto") on Bun — it must
    // be invoked on the crypto object. Broke every integration-export-outbox run.
    this.#uuid = dependencies.uuid ?? (() => crypto.randomUUID())
  }

  async runOnce(): Promise<boolean> {
    const now = this.#now()
    const leaseToken = this.#uuid()
    const batch = await this.dependencies.repository.claimNext({
      now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    })
    if (!batch) return false
    const gate = await this.dependencies.recheck(batch)
    if (!gate.allowed) {
      if (gate.permanent) await this.dependencies.repository.cancel({ batchId: batch.id, leaseToken, code: gate.code })
      else await this.#retry(batch, leaseToken, gate.code)
      return true
    }
    let result: ExportDeliveryResult
    try {
      // Decrypt only after every current privacy/auth gate passes.
      const plaintext = this.dependencies.outbox.decrypt(batch)
      result = await this.dependencies.deliver(batch, plaintext)
    } catch {
      await this.#retry(batch, leaseToken, 'delivery_exception')
      return true
    }
    if (result.ok)
      await this.dependencies.repository.deliverAndAdvance({
        batchId: batch.id,
        cursorId: batch.cursorId,
        leaseToken,
        lastEnqueueOrder: batch.lastEnqueueOrder,
        deliveredAt: this.#now(),
      })
    else if ('gated' in result) {
      if (result.permanent)
        await this.dependencies.repository.cancel({ batchId: batch.id, leaseToken, code: result.code })
      else await this.#retry(batch, leaseToken, result.code)
    } else if (!result.retryable || batch.attempts + 1 >= MAX_ATTEMPTS)
      await this.dependencies.repository.markDeadLetter({ batchId: batch.id, leaseToken, code: result.code })
    else await this.#retry(batch, leaseToken, result.code, result.retryAfterMs)
    return true
  }

  async #retry(batch: ExportBatchRecord, leaseToken: string, code: string, retryAfterMs?: number): Promise<void> {
    if (batch.attempts + 1 >= MAX_ATTEMPTS) {
      await this.dependencies.repository.markDeadLetter({ batchId: batch.id, leaseToken, code })
      return
    }
    const delay = Math.min(retryAfterMs ?? 1_000 * 2 ** batch.attempts, 15 * 60_000)
    await this.dependencies.repository.markRetry({
      batchId: batch.id,
      leaseToken,
      code,
      nextAttemptAt: new Date(this.#now().getTime() + delay),
    })
  }
}
