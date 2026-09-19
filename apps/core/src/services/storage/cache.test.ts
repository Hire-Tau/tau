import { expect, test } from 'bun:test'
import type { StorageSnapshot } from '@tau/shared'
import { createStorageCache } from './cache'

const snapshot: StorageSnapshot = {
  supported: true,
  scanning: false,
  scannedAt: '2026-09-19T00:00:00Z',
  machines: [],
  error: null,
}

test('coalesces concurrent requests and throttles manual refresh without holding requests open', async () => {
  let now = 0
  let scans = 0
  let finish!: (value: StorageSnapshot) => void
  const cache = createStorageCache(
    () => {
      scans++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    () => now
  )
  expect(cache.read().scanning).toBe(true)
  expect(cache.read(true).scanning).toBe(true)
  await Promise.resolve()
  expect(scans).toBe(1)
  finish(snapshot)
  await cache.settled()
  expect(cache.read(true)).toEqual(snapshot)
  now = 60000
  expect(cache.read().scanning).toBe(false)
  expect(cache.read(true).scanning).toBe(true)
  await Promise.resolve()
  expect(scans).toBe(2)
  finish(snapshot)
  await cache.settled()
  now = 360000
  expect(cache.read().scanning).toBe(true)
  await Promise.resolve()
  finish(snapshot)
  await cache.settled()
})

test('preserves last good measurements on failure and does not immediately rescan', async () => {
  let now = 0
  let fail = false
  const cache = createStorageCache(
    async () => {
      if (fail) throw new Error('sensitive path')
      return snapshot
    },
    () => now
  )
  cache.read()
  await cache.settled()
  fail = true
  now = 300000
  cache.read()
  await cache.settled()
  const result = cache.read()
  expect(result.scanning).toBe(false)
  expect(result.scannedAt).toBe(snapshot.scannedAt)
  expect(result.error).toBe('Storage could not be measured. Try refreshing shortly.')
})
