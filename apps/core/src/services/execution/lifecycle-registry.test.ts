import { describe, expect, it } from 'bun:test'
import { ExecutionLifecycleRegistry } from './lifecycle-registry'

describe('ExecutionLifecycleRegistry', () => {
  it('remembers an interrupt requested before a runner attaches', async () => {
    const registry = new ExecutionLifecycleRegistry()
    const lifecycle = registry.registerProvisional('e1', 'a1', 3)
    await lifecycle.requestMaintenanceInterrupt()
    expect(lifecycle.interruptRequested).toBe(true)
    expect(registry.get('e1')).toBe(lifecycle)
    lifecycle.settle()
    lifecycle.markRunnerFinished()
    await lifecycle.settled
    expect(registry.get('e1')).toBeUndefined()
  })

  it('a late rejection from timed-out attempt A cannot clear attempt B', async () => {
    const registry = new ExecutionLifecycleRegistry()
    const lifecycle = registry.registerProvisional('e1', 'a1', 1)
    let rejectA!: (error: Error) => void
    lifecycle.attachQuiesce(() => new Promise<void>((_, reject) => (rejectA = reject)))
    const attemptA = lifecycle.requestMaintenanceInterrupt().catch(() => {})
    lifecycle.resetMaintenanceInterruptAttempt()

    let callsB = 0
    let resolveB!: () => void
    lifecycle.attachQuiesce(() => {
      callsB++
      return new Promise<void>((resolve) => (resolveB = resolve))
    })
    const attemptB = lifecycle.requestMaintenanceInterrupt()
    rejectA(new Error('late A rejection'))
    await attemptA
    const attemptC = lifecycle.requestMaintenanceInterrupt()

    expect(callsB).toBe(1)
    resolveB()
    await Promise.all([attemptB, attemptC])
  })

  it('invokes an attached quiesce callback exactly once', async () => {
    const registry = new ExecutionLifecycleRegistry()
    const lifecycle = registry.registerProvisional('e1', 'a1', 1)
    let calls = 0
    lifecycle.attachQuiesce(async () => void calls++)
    await Promise.all([lifecycle.requestMaintenanceInterrupt(), lifecycle.requestMaintenanceInterrupt()])
    expect(calls).toBe(1)
  })
})
