import { describe, test, expect, mock } from 'bun:test'
import { queryKeys } from '../queryKeys'
import { invalidateSandboxStatus } from './sandboxStatusInvalidation'

function fakeClient() {
  const invalidateQueries = mock((_args: unknown) => {})
  return { invalidateQueries } as any
}

describe('invalidateSandboxStatus', () => {
  test("agent box invalidates that agent's sandbox status", () => {
    const qc = fakeClient()
    invalidateSandboxStatus(qc, 'agent_abc123')
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.agents.sandboxStatus('abc123'),
    })
  })

  test("squad box invalidates that squad's sandbox status", () => {
    const qc = fakeClient()
    invalidateSandboxStatus(qc, 'squad_sq1')
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.sandbox.status('sq1'),
    })
  })

  test('system-manager box invalidates all active agent sandbox-status queries via predicate', () => {
    const qc = fakeClient()
    invalidateSandboxStatus(qc, 'system_manager_user-1')

    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1)
    const arg = qc.invalidateQueries.mock.calls[0][0]
    expect(typeof arg.predicate).toBe('function')
    // Matches an agents/<id>/sandboxStatus key, ignores unrelated keys.
    expect(arg.predicate({ queryKey: ['agents', 'anyone', 'sandboxStatus'] })).toBe(true)
    expect(arg.predicate({ queryKey: ['agents', 'anyone', 'detail'] })).toBe(false)
    expect(arg.predicate({ queryKey: ['squads', 'x'] })).toBe(false)
  })

  test('unknown prefix invalidates nothing', () => {
    const qc = fakeClient()
    invalidateSandboxStatus(qc, 'mystery_xyz')
    expect(qc.invalidateQueries).not.toHaveBeenCalled()
  })
})
