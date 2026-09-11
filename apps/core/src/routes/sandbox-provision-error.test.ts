import { describe, expect, test } from 'bun:test'
import { SandboxProvisionError } from '../services/sandbox/k8s/provision-errors'
import { getSandboxProvisionErrorResponse } from './sandbox-provision-error'

describe('getSandboxProvisionErrorResponse', () => {
  test('maps retryable errors to a safe 503 response', () => {
    const error = new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'Scheduling unavailable.', 28_100)
    const mapped = getSandboxProvisionErrorResponse(error)
    expect(mapped).toEqual({
      status: 503,
      retryAfter: '29',
      body: { error: 'Scheduling unavailable.', code: 'SANDBOX_PROVISION_UNAVAILABLE', retryAfterMs: 28_100 },
    })
  })
  test('omits internal provisioning recovery context', () => {
    const error = new SandboxProvisionError('SANDBOX_PROVISION_UNAVAILABLE', 'Scheduling unavailable.', 1_000, {
      scope: 'scope-secret',
      sandboxKey: 'sandbox-secret',
      circuitVersion: 42,
      refusalId: '00000000-0000-4000-8000-000000000001',
    })

    expect(JSON.stringify(getSandboxProvisionErrorResponse(error))).not.toMatch(
      /scope-secret|sandbox-secret|circuitVersion|00000000-0000-4000-8000-000000000001/
    )
  })

  test('does not map unrelated errors or expose extra properties', () => {
    expect(getSandboxProvisionErrorResponse(new Error('ordinary'))).toBeNull()
    const error = Object.assign(new SandboxProvisionError('SANDBOX_PROVISION_BUSY', 'Busy.', 1), { secret: 'TOKEN' })
    expect(JSON.stringify(getSandboxProvisionErrorResponse(error))).not.toContain('TOKEN')
  })
})
