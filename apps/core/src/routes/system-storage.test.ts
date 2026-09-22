import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware'
import { storageMonitorService } from '../services/storage/monitor'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../test-utils'
import systemRouter from './system'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/system', systemRouter)
const prefix = `system-storage-${crypto.randomUUID()}`
afterAll(() => cleanupTestRbac(prefix))

describe('storage authorization', () => {
  test('storage endpoints reject unauthorized requests before starting a scan', async () => {
    const scan = spyOn(storageMonitorService, 'read')
    try {
      const user = await createTestUser({ prefix })
      const role = await createTestRole({ prefix, permissions: ['squads:read'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
      for (const [path, method] of [
        ['/storage', 'GET'],
        ['/storage/status', 'GET'],
        ['/storage/refresh', 'POST'],
      ]) {
        expect((await app.request(`/api/system${path}`, { method })).status).toBe(401)
        expect((await app.request(`/api/system${path}`, { method, headers: authHeaders(user.token) })).status).toBe(403)
      }
      expect(scan).not.toHaveBeenCalled()
    } finally {
      scan.mockRestore()
    }
  })

  test('system log readers receive a non-cacheable snapshot and can request a refresh', async () => {
    const snapshot = { supported: true, scanning: true, scannedAt: null, error: null, machines: [] }
    const scan = spyOn(storageMonitorService, 'read').mockResolvedValue(snapshot)
    const refresh = spyOn(storageMonitorService, 'refresh').mockResolvedValue(snapshot)
    const statusSnapshot = {
      supported: true,
      scanning: true,
      scannedAt: null,
      error: null,
      monitoring: { intervalHours: 12, alertsEnabled: true, thresholds: [80, 90, 95], nextScanAt: null },
      warnings: [],
    }
    const status = spyOn(storageMonitorService, 'status').mockResolvedValue(statusSnapshot)
    try {
      const user = await createTestUser({ prefix })
      const role = await createTestRole({ prefix, permissions: ['system:logs'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
      for (const [path, method] of [
        ['/storage', 'GET'],
        ['/storage/refresh', 'POST'],
      ]) {
        const response = await app.request(`/api/system${path}`, { method, headers: authHeaders(user.token) })
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual(snapshot)
      }
      const response = await app.request('/api/system/storage/status', { headers: authHeaders(user.token) })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual(statusSnapshot)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      scan.mockRestore()
      refresh.mockRestore()
      status.mockRestore()
    }
  })
})
