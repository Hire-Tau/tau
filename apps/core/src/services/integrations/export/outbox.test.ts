import { expect, test } from 'bun:test'
import { ExportOutbox } from './outbox'

test('encrypts a stable bounded payload and never gives repository plaintext', async () => {
  let inserted: any
  const outbox = new ExportOutbox(
    { createBatch: async (input: any) => (inserted = input), claimNext: async () => null } as any,
    {
      encrypt: (bytes) => ({ encrypted: Buffer.from(bytes).toString('base64'), iv: 'iv' }),
      decrypt: ({ encrypted }) => Buffer.from(encrypted, 'base64'),
    },
    () => new Date(0),
    (() => {
      let n = 0
      return () => `id-${++n}`
    })()
  )
  const plaintext = new TextEncoder().encode('{"role":"user"}\n')
  await outbox.enqueue({
    cursor: { id: 'cursor', consentId: 'consent', lastDeliveredEnqueueOrder: 1n },
    plaintext,
    firstEnqueueOrder: 2n,
    lastEnqueueOrder: 2n,
    recordCount: 1,
  })
  expect(inserted).toMatchObject({
    cursorId: 'cursor',
    recordCount: 1,
    byteCount: plaintext.byteLength,
    encryptedPayload: Buffer.from(plaintext).toString('base64'),
  })
  expect(inserted).not.toHaveProperty('plaintext')
})
