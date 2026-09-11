import { describe, expect, test } from 'bun:test'
import { SandboxProvisionError } from '../sandbox/k8s/provision-errors'
import { getProvisioningWebSocketClose } from './terminal'

describe('terminal provisioning close', () => {
  test('uses retryable 1013 with a protocol-safe reason', () => {
    const close = getProvisioningWebSocketClose(
      new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'TOKEN-SECRET', 28_100)
    )
    expect(close).toEqual({ code: 1013, reason: 'Sandbox temporarily unavailable. Retry in 29s.' })
    expect(Buffer.byteLength(close!.reason)).toBeLessThanOrEqual(123)
    expect(close!.reason).not.toContain('TOKEN-SECRET')
  })
  test('omits internal provisioning recovery context', () => {
    const error = new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'safe', 1_000, {
      scope: 'scope-secret',
      sandboxKey: 'sandbox-secret',
      circuitVersion: 42,
      refusalId: '00000000-0000-4000-8000-000000000001',
    })

    expect(JSON.stringify(getProvisioningWebSocketClose(error))).not.toMatch(
      /scope-secret|sandbox-secret|circuitVersion|00000000-0000-4000-8000-000000000001/
    )
  })

  test('does not map ordinary errors', () => expect(getProvisioningWebSocketClose(new Error('x'))).toBeNull())
})
