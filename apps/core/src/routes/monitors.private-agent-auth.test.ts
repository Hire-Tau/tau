import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentTokens, agents, agentTypes, db, monitors, squads, systemTokens } from '../db'
import { Monitor } from '../entities/Monitor'
import { identityMiddleware } from '../middleware/identity'
import { createSystemToken } from '../services/auth/system-tokens'
import { getSandboxManager } from '../services/sandbox'
import { monitorSupervisor } from '../services/monitors/monitor-supervisor'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, createTestUser } from '../test-utils'
import { monitorsRouter } from './monitors'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/monitors', monitorsRouter)

test('keeps private monitor reads owner-exclusive', async () => {
  const prefix = `private-monitor-${randomUUID()}`
  const owner = await createTestUser({ prefix })
  const foreignAdmin = await createTestAdmin({ prefix })
  const agentId = randomUUID()
  const tokenSquadId = randomUUID()
  const foreignSquadId = randomUUID()
  const callerId = randomUUID()
  const callerTypeId = `${prefix}-caller-type`
  const sameTargetId = randomUUID()
  const foreignTargetId = randomUUID()
  const unownedTargetId = randomUUID()
  const extraMonitorIds: string[] = []
  let monitorId: string | undefined
  let cancelSpy: { mockRestore(): void } | undefined
  let execStatusSpy: { mockRestore(): void } | undefined
  let execSpy: { mockRestore(): void } | undefined
  let systemTokenId: string | undefined

  try {
    await db.insert(agentTypes).values({
      id: callerTypeId,
      name: `${prefix} caller`,
      model: 'test:model',
      systemPrompt: 'test',
      extraScopes: ['monitors:read', 'monitors:write'],
    })
    await db.insert(squads).values([
      { id: tokenSquadId, name: `${prefix}-tokens`, purpose: 'test' },
      { id: foreignSquadId, name: `${prefix}-foreign`, purpose: 'test' },
    ])
    await db.insert(agents).values([
      { id: agentId, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: callerId, agentTypeId: callerTypeId, squadId: tokenSquadId },
      { id: sameTargetId, agentTypeId: 'artifact-builder', squadId: tokenSquadId },
      { id: foreignTargetId, agentTypeId: 'artifact-builder', squadId: foreignSquadId },
      { id: unownedTargetId, agentTypeId: 'artifact-builder' },
    ])
    const monitor = await Monitor.create({
      agentId,
      sandboxId: 'private-monitor-sandbox',
      label: `${prefix}-monitor`,
      command: 'echo private',
      processId: `${prefix}-process`,
      timeoutMs: 30_000,
      maxBatchLines: 20,
      maxBatchBytes: 4096,
      batchDebounceMs: 750,
    })
    monitorId = monitor.id
    for (const targetId of [sameTargetId, foreignTargetId, unownedTargetId]) {
      const extra = await Monitor.create({
        agentId: targetId,
        sandboxId: `sandbox-${targetId}`,
        label: `${prefix}-${targetId}`,
        command: 'echo scope',
        processId: `${prefix}-${targetId}`,
        timeoutMs: 30_000,
        maxBatchLines: 20,
        maxBatchBytes: 4096,
        batchDebounceMs: 750,
      })
      extraMonitorIds.push(extra.id)
    }
    const callerToken = await createTestAgentToken({ agentId: callerId, squadId: tokenSquadId })
    const ownerAgentToken = await createTestAgentToken({ agentId, squadId: tokenSquadId, userId: owner.id })
    const malformedSelfToken = await createTestAgentToken({ agentId, squadId: tokenSquadId })
    const systemMonitor = await createSystemToken({
      name: `${prefix}-system`,
      scopes: ['monitors:read', 'monitors:write'],
    })
    systemTokenId = systemMonitor.record.id
    cancelSpy = spyOn(monitorSupervisor, 'cancel').mockResolvedValue(undefined)
    const sandboxManager = getSandboxManager()
    execStatusSpy = spyOn(sandboxManager, 'execStatus').mockResolvedValue(0)
    execSpy = spyOn(sandboxManager, 'exec').mockResolvedValue(Buffer.from('owner log\n'))

    const deniedResponses: Response[] = []
    for (const token of [foreignAdmin.token, systemMonitor.token, malformedSelfToken.token]) {
      for (const path of [
        `/api/monitors?agentId=${agentId}`,
        `/api/monitors/${monitor.id}`,
        `/api/monitors/${monitor.id}/logs`,
      ]) {
        deniedResponses.push(await app.request(path, { headers: authHeaders(token) }))
      }
    }

    expect(execStatusSpy).not.toHaveBeenCalled()
    expect(execSpy).not.toHaveBeenCalled()
    for (const denied of deniedResponses) {
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Forbidden' })
    }

    const malformedDetail = await app.request(`/api/monitors/${monitor.id}`, {
      headers: authHeaders(malformedSelfToken.token),
    })
    expect(malformedDetail.status).toBe(403)

    for (const token of [owner.token, ownerAgentToken.token]) {
      for (const path of [
        `/api/monitors?agentId=${agentId}`,
        '/api/monitors',
        `/api/monitors/${monitor.id}`,
        `/api/monitors/${monitor.id}/logs`,
      ]) {
        const ownerResponse = await app.request(path, { headers: authHeaders(token) })
        expect(ownerResponse.status).toBe(200)
        if (path.endsWith('/logs')) expect(await ownerResponse.json()).toEqual({ lines: ['owner log'] })
      }
    }

    const statusBeforeDeniedCancel = (await Monitor.mustFind(monitor.id)).status
    const deniedCancel = await app.request(`/api/monitors/${monitor.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(malformedSelfToken.token),
    })
    expect(deniedCancel.status).toBe(403)
    expect(cancelSpy).not.toHaveBeenCalled()
    expect((await Monitor.mustFind(monitor.id)).status).toBe(statusBeforeDeniedCancel)
    const ownerCancel = await app.request(`/api/monitors/${monitor.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(owner.token),
    })
    expect(ownerCancel.status).toBe(200)
    const adminCancel = await app.request(`/api/monitors/${monitor.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(foreignAdmin.token),
    })
    expect(adminCancel.status).toBe(200)
    expect(cancelSpy).toHaveBeenCalledWith(monitor.id)
    const systemCancel = await app.request(`/api/monitors/${monitor.id}/cancel`, {
      method: 'POST',
      headers: authHeaders(systemMonitor.token),
    })
    expect(systemCancel.status).toBe(200)

    const sameFiltered = await app.request(`/api/monitors?agentId=${sameTargetId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(sameFiltered.status).toBe(200)
    for (const entry of [
      { path: `/api/monitors/${extraMonitorIds[0]}`, method: 'GET' },
      { path: `/api/monitors/${extraMonitorIds[0]}/logs`, method: 'GET' },
      { path: `/api/monitors/${extraMonitorIds[0]}/cancel`, method: 'POST' },
    ]) {
      const sameAllowed = await app.request(entry.path, {
        method: entry.method,
        headers: authHeaders(callerToken.token),
      })
      expect(sameAllowed.status).toBe(200)
    }

    const foreignFiltered = await app.request(`/api/monitors?agentId=${foreignTargetId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(foreignFiltered.status).toBe(403)
    for (const entry of [
      { path: `/api/monitors/${extraMonitorIds[1]}`, method: 'GET' },
      { path: `/api/monitors/${extraMonitorIds[1]}/logs`, method: 'GET' },
      { path: `/api/monitors/${extraMonitorIds[1]}/cancel`, method: 'POST' },
    ]) {
      const foreignDenied = await app.request(entry.path, {
        method: entry.method,
        headers: authHeaders(callerToken.token),
      })
      expect(foreignDenied.status).toBe(403)
    }
    const unownedFiltered = await app.request(`/api/monitors?agentId=${unownedTargetId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(unownedFiltered.status).toBe(403)

    for (const token of [foreignAdmin.token, systemMonitor.token]) {
      for (const monitorId of [extraMonitorIds[0], extraMonitorIds[2]]) {
        const detail = await app.request(`/api/monitors/${monitorId}`, { headers: authHeaders(token) })
        expect(detail.status).toBe(200)
        const cancel = await app.request(`/api/monitors/${monitorId}/cancel`, {
          method: 'POST',
          headers: authHeaders(token),
        })
        expect(cancel.status).toBe(200)
      }
    }

    const adminList = await app.request('/api/monitors', { headers: authHeaders(foreignAdmin.token) })
    expect(adminList.status).toBe(200)
    const adminIds = (await adminList.json()).map((row: { id: string }) => row.id)
    expect(adminIds).not.toContain(monitor.id)
    expect(adminIds).toContain(extraMonitorIds[2])
    const systemList = await app.request('/api/monitors', { headers: authHeaders(systemMonitor.token) })
    expect(systemList.status).toBe(200)
    const systemIds = (await systemList.json()).map((row: { id: string }) => row.id)
    expect(systemIds).not.toContain(monitor.id)
    expect(systemIds).toContain(extraMonitorIds[2])

    const ownerList = await app.request('/api/monitors', { headers: authHeaders(owner.token) })
    expect(ownerList.status).toBe(200)
    expect((await ownerList.json()).map((row: { id: string }) => row.id)).toContain(monitor.id)

    const missing = await app.request(`/api/monitors/${randomUUID()}`, {
      headers: authHeaders(foreignAdmin.token),
    })
    expect(missing.status).toBe(403)
    const invalid = await app.request('/api/monitors/bad%20id', {
      headers: authHeaders(foreignAdmin.token),
    })
    expect(invalid.status).toBe(400)
  } finally {
    cancelSpy?.mockRestore()
    execStatusSpy?.mockRestore()
    execSpy?.mockRestore()
    if (monitorId) await db.delete(monitors).where(eq(monitors.id, monitorId))
    if (extraMonitorIds.length) await db.delete(monitors).where(inArray(monitors.id, extraMonitorIds))
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, [agentId, callerId]))
    await db
      .delete(agents)
      .where(inArray(agents.id, [agentId, callerId, sameTargetId, foreignTargetId, unownedTargetId]))
    await db.delete(squads).where(inArray(squads.id, [tokenSquadId, foreignSquadId]))
    await db.delete(agentTypes).where(eq(agentTypes.id, callerTypeId))
    if (systemTokenId) await db.delete(systemTokens).where(eq(systemTokens.id, systemTokenId))
    await cleanupTestRbac(prefix)
  }
})
