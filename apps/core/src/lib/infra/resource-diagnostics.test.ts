import { describe, expect, test } from 'bun:test'
import { ResourceDiagnostics } from './resource-diagnostics'

describe('ResourceDiagnostics', () => {
  test('finishes a resource lease exactly once', () => {
    const diagnostics = new ResourceDiagnostics()
    const lease = diagnostics.begin('sandbox_log_stream')

    expect(diagnostics.snapshot().sandbox_log_stream).toEqual({
      active: 1,
      started: 1,
      completed: 0,
      cancelled: 0,
      failed: 0,
    })

    lease.finish('cancelled')
    lease.finish('failed')

    expect(diagnostics.snapshot().sandbox_log_stream).toEqual({
      active: 0,
      started: 1,
      completed: 0,
      cancelled: 1,
      failed: 0,
    })
  })

  test('keeps independent closed-enum counters for each resource kind', () => {
    const diagnostics = new ResourceDiagnostics()
    diagnostics.begin('pod_log_transport').finish('failed')

    expect(diagnostics.snapshot().pod_log_transport.failed).toBe(1)
    expect(diagnostics.snapshot().port_forward.failed).toBe(0)
  })
})
