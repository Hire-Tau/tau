import { expect, test } from 'bun:test'
import { RuntimeReadiness } from './readiness'

test('startup and shutdown refuse readiness while keeping the service identity', async () => {
  const readiness = new RuntimeReadiness('api', '0d841bd2-0bd0-4c78-9a07-914399e7a6bc')
  expect(readiness.response().status).toBe(503)
  readiness.markReady()
  const response = readiness.response()
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({
    service: 'api',
    ready: true,
    instanceId: '0d841bd2-0bd0-4c78-9a07-914399e7a6bc',
  })
  readiness.markStopping()
  expect(readiness.response().status).toBe(503)
})

test('unconfigured or invalid launch identifiers never reflect environment contents', async () => {
  const readiness = new RuntimeReadiness('worker', 'arbitrary-secret')
  readiness.markReady()
  expect(await readiness.response().json()).toEqual({ service: 'worker', ready: true, instanceId: null })
})
