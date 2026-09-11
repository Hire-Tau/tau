import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import * as permissions from './permissions'
import type { Identity } from './permissions'

let hasPermissionSpy: Mock<typeof permissions.hasPermission>

beforeEach(() => {
  hasPermissionSpy = spyOn(permissions, 'hasPermission').mockResolvedValue(true)
})

afterEach(() => {
  hasPermissionSpy.mockRestore()
})

async function getHelper() {
  return import('./agent-resource-access')
}

describe('hasAgentResourcePermission', () => {
  test('enforces squad, private owner, orphan, and missing-target precedence', async () => {
    const { hasAgentResourcePermission } = await getHelper()
    const ownerUser: Identity = { type: 'user', userId: 'owner-a' }
    const ownerAgent: Identity = {
      type: 'agent',
      agentId: 'owner-agent',
      squadId: null,
      userId: 'owner-a',
    }
    const wildcardAdmin: Identity = { type: 'user', userId: 'admin' }
    const systemReader: Identity = {
      type: 'system',
      systemTokenId: 'system-reader',
      name: 'reader',
      scopes: ['agents:read'],
    }
    const legacyIdentity: Identity = { type: 'legacy' }
    const userlessAgent: Identity = {
      type: 'agent',
      agentId: 'caller-agent',
      squadId: 'caller-squad',
    }
    const squadTarget = { squadId: 'squad-a', ownerUserId: 'foreign-owner' }
    const privateTarget = { squadId: null, ownerUserId: 'owner-a' }
    const orphanTarget = { squadId: null, ownerUserId: null }

    expect(await hasAgentResourcePermission(ownerUser, privateTarget, 'agents:read')).toBe(true)
    expect(await hasAgentResourcePermission(ownerAgent, privateTarget, 'agents:read')).toBe(true)
    expect(await hasAgentResourcePermission(wildcardAdmin, privateTarget, 'agents:read')).toBe(false)
    expect(await hasAgentResourcePermission(systemReader, privateTarget, 'agents:read')).toBe(false)
    expect(await hasAgentResourcePermission(legacyIdentity, privateTarget, 'agents:read')).toBe(false)
    expect(await hasAgentResourcePermission(userlessAgent, orphanTarget, 'agents:read')).toBe(false)
    expect(hasPermissionSpy).not.toHaveBeenCalled()

    expect(await hasAgentResourcePermission(userlessAgent, squadTarget, 'agents:read')).toBe(true)
    expect(hasPermissionSpy).toHaveBeenLastCalledWith(userlessAgent, 'agents:read', 'squad-a')

    expect(await hasAgentResourcePermission(systemReader, orphanTarget, 'agents:read')).toBe(true)
    expect(hasPermissionSpy).toHaveBeenLastCalledWith(systemReader, 'agents:read')

    hasPermissionSpy.mockClear()
    expect(await hasAgentResourcePermission(ownerUser, null, 'agents:read')).toBe(false)
    expect(hasPermissionSpy).not.toHaveBeenCalled()
  })
})
