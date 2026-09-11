import { expect, test } from 'bun:test'
import { IntegrationExportWorker } from './worker'

test('advances cursor only after successful delivery', async () => {
  let advanced = false
  const batch = { id: 'batch', cursorId: 'cursor', lastEnqueueOrder: 9n, attempts: 0 }
  const worker = new IntegrationExportWorker({
    repository: { claimNext: async () => batch, deliverAndAdvance: async () => (advanced = true) } as any,
    outbox: { decrypt: () => new Uint8Array([1]) } as any,
    recheck: async () => ({ allowed: true }),
    deliver: async () => ({ ok: true }),
    now: () => new Date(0),
    uuid: () => 'lease',
  })
  expect(await worker.runOnce()).toBe(true)
  expect(advanced).toBe(true)
})

test('failed gate performs no decrypt or delivery', async () => {
  let calls = 0
  const worker = new IntegrationExportWorker({
    repository: { claimNext: async () => ({ id: 'batch' }), cancel: async () => true } as any,
    outbox: {
      decrypt: () => {
        calls++
        return new Uint8Array()
      },
    } as any,
    recheck: async () => ({ allowed: false, code: 'consent_revoked', permanent: true }),
    deliver: async () => {
      calls++
      return { ok: true }
    },
    uuid: () => 'lease',
  })
  await worker.runOnce()
  expect(calls).toBe(0)
})

test('transient gate denial retries without decrypting or scrubbing', async () => {
  let retried = false
  let canceled = false
  const worker = new IntegrationExportWorker({
    repository: {
      claimNext: async () => ({ id: 'batch', attempts: 0 }),
      markRetry: async () => (retried = true),
      cancel: async () => (canceled = true),
    } as any,
    outbox: {
      decrypt: () => {
        throw new Error('must not decrypt')
      },
    } as any,
    recheck: async () => ({ allowed: false, code: 'validation_stale', permanent: false }),
    deliver: async () => ({ ok: true }),
    now: () => new Date(0),
    uuid: () => 'lease',
  })
  await worker.runOnce()
  expect(retried).toBe(true)
  expect(canceled).toBe(false)
})

test('thrown decrypt or delivery errors transition to retry', async () => {
  let retried = false
  const worker = new IntegrationExportWorker({
    repository: {
      claimNext: async () => ({ id: 'batch', attempts: 0 }),
      markRetry: async () => (retried = true),
    } as any,
    outbox: {
      decrypt: () => {
        throw new Error('key rotation')
      },
    } as any,
    recheck: async () => ({ allowed: true }),
    deliver: async () => ({ ok: true }),
    now: () => new Date(0),
    uuid: () => 'lease',
  })
  await worker.runOnce()
  expect(retried).toBe(true)
})

test('retryable delivery failure does not advance the cursor', async () => {
  let advanced = false
  let retried = false
  const batch = { id: 'batch', cursorId: 'cursor', lastEnqueueOrder: 9n, attempts: 0 }
  const worker = new IntegrationExportWorker({
    repository: {
      claimNext: async () => batch,
      deliverAndAdvance: async () => (advanced = true),
      markRetry: async () => (retried = true),
    } as any,
    outbox: { decrypt: () => new Uint8Array([1]) } as any,
    recheck: async () => ({ allowed: true }),
    deliver: async () => ({ ok: false, code: 'timeout', retryable: true }),
    now: () => new Date(0),
    uuid: () => 'lease',
  })
  await worker.runOnce()
  expect(retried).toBe(true)
  expect(advanced).toBe(false)
})

test('uses the built-in uuid by default without throwing (crypto.randomUUID must be bound)', async () => {
  let deliveredLease: string | undefined
  const batch = { id: 'batch', cursorId: 'cursor', lastEnqueueOrder: 9n, attempts: 0 }
  // NO `uuid` dependency — exercise the real default. Before the fix this threw
  // ERR_INVALID_THIS ("Expected this to be instanceof Crypto") on the first
  // runOnce because `crypto.randomUUID` was stored and called unbound.
  const worker = new IntegrationExportWorker({
    repository: {
      claimNext: async () => batch,
      deliverAndAdvance: async ({ leaseToken }: { leaseToken: string }) => {
        deliveredLease = leaseToken
      },
    } as any,
    outbox: { decrypt: () => new Uint8Array([1]) } as any,
    recheck: async () => ({ allowed: true }),
    deliver: async () => ({ ok: true }),
    now: () => new Date(0),
  })
  expect(await worker.runOnce()).toBe(true)
  // A real UUID was generated and threaded through to the repository.
  expect(deliveredLease).toMatch(/^[0-9a-f-]{36}$/)
})
