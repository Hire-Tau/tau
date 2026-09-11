import { expect, test } from 'bun:test'
import { createSpeechClientPool } from './speech-client'

test('rotating Google credentials preserves active speech and drains obsolete clients once', async () => {
  let credential = 'first'
  const closed: string[] = []
  const created: string[] = []
  const pool = createSpeechClientPool({
    credential: () => credential,
    create: (key) => {
      created.push(key!)
      return {
        key,
        close: async () => {
          closed.push(key!)
        },
      }
    },
  })
  const first = await pool.acquire()
  const concurrent = await pool.acquire()
  expect(created).toEqual(['first'])
  credential = 'second'
  const second = await pool.acquire()
  expect(second.client.key).toBe('second')
  expect(closed).toEqual([])
  await first.release()
  await first.release()
  expect(closed).toEqual([])
  await concurrent.release()
  expect(closed).toEqual(['first'])
  await pool.retire()
  expect(closed).toEqual(['first'])
  await second.release()
  expect(closed).toEqual(['first', 'second'])
})

test('a slow old-client shutdown cannot change the client leased by an overlapping request', async () => {
  let credential = 'first'
  const shutdown = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const closed: string[] = []
  const pool = createSpeechClientPool({
    credential: () => credential,
    create: (key) => ({
      key,
      close: async () => {
        if (key === 'first') {
          closing.resolve()
          await shutdown.promise
        }
        closed.push(key!)
      },
    }),
  })
  const first = await pool.acquire()
  await first.release()
  credential = 'second'
  const pending = pool.acquire()
  await closing.promise
  await pool.retire()
  credential = 'third'
  const third = await pool.acquire()
  shutdown.resolve()
  const second = await pending
  expect(second.client.key).toBe('second')
  expect(third.client.key).toBe('third')
  await second.release()
  await third.release()
  await pool.retire()
  expect(closed).toEqual(['first', 'second', 'third'])
})
