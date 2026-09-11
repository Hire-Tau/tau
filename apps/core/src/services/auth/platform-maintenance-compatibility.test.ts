import { describe, expect, test } from 'bun:test'
import { PLATFORM_MAINTENANCE_HEADERS } from '@tau/shared'
import {
  decidePlatformMaintenanceCompatibility,
  legacyUpgradePolicy,
  parsePlatformMaintenanceHeaders,
} from './platform-maintenance-compatibility'

const complete = {
  protocolVersion: 1,
  callerVersion: 'a'.repeat(40),
  instanceId: '123e4567-e89b-42d3-a456-426614174000',
  correlationId: '123e4567-e89b-42d3-a456-426614174001',
}
const parsed = (values: Record<string, string> = {}) => parsePlatformMaintenanceHeaders((name) => values[name])

describe('legacy upgrade policy', () => {
  test('defaults only absent and empty values to observe', () => {
    expect(legacyUpgradePolicy(undefined)).toBe('observe')
    expect(legacyUpgradePolicy('')).toBe('observe')
    expect(legacyUpgradePolicy('enforce')).toBe('enforce')
    expect(legacyUpgradePolicy('disabled')).toBe('disabled')
    expect(() => legacyUpgradePolicy('allow')).toThrow('TAU_LEGACY_PLATFORM_MAINTENANCE_UPGRADE')
  })
})

describe('platform maintenance compatibility decision', () => {
  test('observe accepts wholly absent legacy context', () => {
    expect(decidePlatformMaintenanceCompatibility('observe', parsed())).toEqual({
      allowed: true,
      context: { protocolVersion: null, callerVersion: null, instanceId: null, correlationId: null },
      legacyUnknown: true,
    })
  })

  test('accepts complete protocol 1 context in observe and enforce', () => {
    const headers = {
      [PLATFORM_MAINTENANCE_HEADERS.protocol]: '1',
      [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: complete.callerVersion,
      [PLATFORM_MAINTENANCE_HEADERS.instanceId]: complete.instanceId,
      [PLATFORM_MAINTENANCE_HEADERS.correlationId]: complete.correlationId,
    }
    expect(decidePlatformMaintenanceCompatibility('observe', parsed(headers))).toMatchObject({ allowed: true })
    expect(decidePlatformMaintenanceCompatibility('enforce', parsed(headers))).toMatchObject({
      allowed: true,
      context: complete,
    })
  })

  test.each([
    [{ [PLATFORM_MAINTENANCE_HEADERS.protocol]: '1x' }],
    [{ [PLATFORM_MAINTENANCE_HEADERS.protocol]: '-1' }],
    [{ [PLATFORM_MAINTENANCE_HEADERS.protocol]: '999999999999999999999999' }],
    [{ [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: 'A'.repeat(40) }],
    [{ [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: 'a'.repeat(39) }],
    [{ [PLATFORM_MAINTENANCE_HEADERS.instanceId]: 'not-a-uuid' }],
  ])('rejects malformed present values without returning them', (headers) => {
    const result = decidePlatformMaintenanceCompatibility('observe', parsed(headers))
    expect(result).toEqual({ allowed: false, reasonCode: 'invalid_context' })
    expect(JSON.stringify(result)).not.toContain(Object.values(headers)[0]!)
  })

  test('observe rejects partial, old, and future protocol context while preserving safe fields', () => {
    for (const protocol of ['0', '999']) {
      const result = decidePlatformMaintenanceCompatibility(
        'observe',
        parsed({
          [PLATFORM_MAINTENANCE_HEADERS.protocol]: protocol,
          [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: complete.callerVersion,
          [PLATFORM_MAINTENANCE_HEADERS.instanceId]: complete.instanceId,
          [PLATFORM_MAINTENANCE_HEADERS.correlationId]: complete.correlationId,
        })
      )
      expect(result).toEqual({
        allowed: false,
        reasonCode: 'compatibility_floor',
        context: { ...complete, protocolVersion: Number(protocol) },
      })
    }
    expect(
      decidePlatformMaintenanceCompatibility(
        'observe',
        parsed({ [PLATFORM_MAINTENANCE_HEADERS.instanceId]: complete.instanceId })
      )
    ).toEqual({
      allowed: false,
      reasonCode: 'compatibility_floor',
      context: { protocolVersion: null, callerVersion: null, instanceId: complete.instanceId, correlationId: null },
    })
  })

  test('enforce rejects absent, old, and incomplete context', () => {
    expect(decidePlatformMaintenanceCompatibility('enforce', parsed())).toEqual({
      allowed: false,
      reasonCode: 'compatibility_floor',
    })
    expect(
      decidePlatformMaintenanceCompatibility(
        'enforce',
        parsed({
          [PLATFORM_MAINTENANCE_HEADERS.protocol]: '0',
          [PLATFORM_MAINTENANCE_HEADERS.callerVersion]: complete.callerVersion,
          [PLATFORM_MAINTENANCE_HEADERS.instanceId]: complete.instanceId,
          [PLATFORM_MAINTENANCE_HEADERS.correlationId]: complete.correlationId,
        })
      )
    ).toEqual({
      allowed: false,
      reasonCode: 'compatibility_floor',
      context: { ...complete, protocolVersion: 0 },
    })
    expect(
      decidePlatformMaintenanceCompatibility('enforce', parsed({ [PLATFORM_MAINTENANCE_HEADERS.protocol]: '1' }))
    ).toEqual({
      allowed: false,
      reasonCode: 'compatibility_floor',
      context: { protocolVersion: 1, callerVersion: null, instanceId: null, correlationId: null },
    })
  })

  test('disabled rejects every context', () => {
    expect(decidePlatformMaintenanceCompatibility('disabled', parsed())).toEqual({
      allowed: false,
      reasonCode: 'compatibility_disabled',
    })
  })
})
