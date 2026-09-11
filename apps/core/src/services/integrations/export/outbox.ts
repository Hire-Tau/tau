import { randomUUID } from 'crypto'

export const EXPORT_MAX_RECORDS = 100
export const EXPORT_MAX_BYTES = 256 * 1024

export interface ExportBatchRecord {
  id: string
  cursorId: string
  idempotencyKey: string
  firstEnqueueOrder: bigint
  lastEnqueueOrder: bigint
  recordCount: number
  byteCount: number
  encryptedPayload: string | null
  payloadIv: string | null
  state: 'pending' | 'processing' | 'retry_wait' | 'delivered' | 'dead_letter' | 'canceled'
  attempts: number
  leaseToken: string | null
  leaseExpiresAt: Date | null
  nextAttemptAt: Date
}

export interface ExportCursorRecord {
  id: string
  consentId: string
  lastDeliveredEnqueueOrder: bigint
}
export interface EncryptedExportPayload {
  encrypted: string
  iv: string
}

export interface ExportOutboxRepository {
  createBatch(
    input: Omit<ExportBatchRecord, 'state' | 'attempts' | 'leaseToken' | 'leaseExpiresAt' | 'nextAttemptAt'> & {
      now: Date
    }
  ): Promise<ExportBatchRecord | null>
  claimNext(input: { now: Date; leaseToken: string; leaseExpiresAt: Date }): Promise<ExportBatchRecord | null>
  markRetry(input: { batchId: string; leaseToken: string; nextAttemptAt: Date; code: string }): Promise<boolean>
  markDeadLetter(input: { batchId: string; leaseToken: string; code: string }): Promise<boolean>
  deliverAndAdvance(input: {
    batchId: string
    cursorId: string
    leaseToken: string
    lastEnqueueOrder: bigint
    deliveredAt: Date
  }): Promise<boolean>
  cancel(input: { batchId: string; leaseToken: string; code: string }): Promise<boolean>
}

export interface ExportPayloadCipher {
  encrypt(plaintext: Uint8Array): EncryptedExportPayload
  decrypt(payload: EncryptedExportPayload): Uint8Array
}

export class ExportOutbox {
  constructor(
    private readonly repository: ExportOutboxRepository,
    private readonly cipher: ExportPayloadCipher,
    private readonly now = () => new Date(),
    private readonly uuid: () => string = randomUUID
  ) {}

  async enqueue(input: {
    cursor: ExportCursorRecord
    plaintext: Uint8Array
    firstEnqueueOrder: bigint
    lastEnqueueOrder: bigint
    recordCount: number
  }): Promise<ExportBatchRecord | null> {
    if (
      input.recordCount < 1 ||
      input.recordCount > EXPORT_MAX_RECORDS ||
      input.plaintext.byteLength > EXPORT_MAX_BYTES ||
      input.firstEnqueueOrder <= input.cursor.lastDeliveredEnqueueOrder ||
      input.lastEnqueueOrder < input.firstEnqueueOrder
    )
      throw new Error('Invalid export batch boundary')
    const encrypted = this.cipher.encrypt(input.plaintext)
    return this.repository.createBatch({
      id: this.uuid(),
      cursorId: input.cursor.id,
      idempotencyKey: this.uuid(),
      firstEnqueueOrder: input.firstEnqueueOrder,
      lastEnqueueOrder: input.lastEnqueueOrder,
      recordCount: input.recordCount,
      byteCount: input.plaintext.byteLength,
      encryptedPayload: encrypted.encrypted,
      payloadIv: encrypted.iv,
      now: this.now(),
    })
  }

  decrypt(batch: ExportBatchRecord): Uint8Array {
    if (!batch.encryptedPayload || !batch.payloadIv) throw new Error('Export payload unavailable')
    return this.cipher.decrypt({ encrypted: batch.encryptedPayload, iv: batch.payloadIv })
  }
}
