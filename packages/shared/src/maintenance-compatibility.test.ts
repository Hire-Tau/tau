import { describe, expect, it } from 'bun:test'
import { PLATFORM_MAINTENANCE_HEADERS, PLATFORM_MAINTENANCE_PROTOCOL_VERSION } from './maintenance-compatibility'

describe('platform maintenance compatibility protocol', () => {
  it('has a stable version and lowercase wire header names', () => {
    expect(PLATFORM_MAINTENANCE_PROTOCOL_VERSION).toBe(1)
    expect(PLATFORM_MAINTENANCE_HEADERS).toEqual({
      protocol: 'x-tau-maintenance-protocol',
      callerVersion: 'x-tau-caller-version',
      instanceId: 'x-tau-instance-id',
      correlationId: 'x-tau-correlation-id',
    })
  })
})
