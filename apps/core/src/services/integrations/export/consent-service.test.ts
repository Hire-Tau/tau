import { expect, test } from 'bun:test'
import { ExportConsentService } from './consent-service'

test('adopts current high-water and requires an eligible top-level squad conversation', async () => {
  let created: any
  const audits: unknown[] = []
  const service = new ExportConsentService(
    {
      activeForAgent: async () => null,
      maxEnqueueOrder: async () => 42n,
      createWithCursor: async (input) => ({
        ...(created = input),
        id: 'consent',
        consentedAt: new Date(0),
        revokedAt: null,
      }),
      revoke: async () => null,
    },
    { check: async () => ({ allowed: true }) },
    undefined,
    { record: async (event) => void audits.push(event) }
  )
  await service.enable({
    agent: { id: 'agent', squadId: 'squad', parentAgentId: null },
    connectionId: 'connection',
    userId: 'user',
    policyVersion: 1,
    projectionVersion: 1,
  })
  expect(created).toMatchObject({ adoptedEnqueueOrder: 42n, consentedByUserId: 'user' })
  expect(audits).toEqual([expect.objectContaining({ action: 'consent_enable', userId: 'user', agentId: 'agent' })])
  await expect(
    service.enable({
      agent: { id: 'child', squadId: 'squad', parentAgentId: 'parent' },
      connectionId: 'connection',
      userId: 'user',
      policyVersion: 1,
      projectionVersion: 1,
    })
  ).rejects.toThrow('not eligible')
})

test('denied capability gate creates no consent', async () => {
  let created = false
  let checked = false
  const service = new ExportConsentService(
    {
      activeForAgent: async () => null,
      maxEnqueueOrder: async () => 1n,
      createWithCursor: async () => {
        created = true
        throw new Error('must not create')
      },
      revoke: async () => null,
    },
    {
      check: async () => {
        checked = true
        return { allowed: false }
      },
    }
  )
  await expect(
    service.enable({
      agent: { id: 'agent', squadId: 'squad', parentAgentId: null },
      connectionId: 'connection',
      userId: 'user',
      policyVersion: 1,
      projectionVersion: 1,
    })
  ).rejects.toThrow('capability unavailable')
  expect(checked).toBe(true)
  expect(created).toBe(false)
})
