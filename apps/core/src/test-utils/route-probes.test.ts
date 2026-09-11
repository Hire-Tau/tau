import { expect, test } from 'bun:test'
import { probeWithConcurrency, uniqueRouteEndpoints } from './route-probes'

test('one endpoint probe traverses all duplicate middleware registrations, preserving distinct verbs', () => {
  expect(
    uniqueRouteEndpoints([
      { method: 'get', path: '/api/a' },
      { method: 'GET', path: '/api/a' },
      { method: 'POST', path: '/api/a' },
      { method: 'HEAD', path: '/api/a' },
    ])
  ).toEqual([
    { method: 'GET', path: '/api/a' },
    { method: 'POST', path: '/api/a' },
  ])
})

test('route probes stay bounded, cover every endpoint and drain started probes after failure', async () => {
  let active = 0
  let peak = 0
  const seen: number[] = []
  await probeWithConcurrency([1, 2, 3, 4, 5], 2, async (entry) => {
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    seen.push(entry)
    active--
  })
  expect(peak).toBe(2)
  expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  await expect(
    probeWithConcurrency([1, 2, 3], 2, async (entry) => {
      active++
      try {
        await Promise.resolve()
        if (entry === 1) throw new Error('fixture failure')
      } finally {
        active--
      }
    })
  ).rejects.toThrow('Route probe failed')
  expect(active).toBe(0)
})
