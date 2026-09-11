import { describe, expect, test } from 'bun:test'
import { logRunnerMilestone, startRunnerTiming } from './runner-timing'

describe('runner timing instrumentation', () => {
  test('creates timing context with input fields and entered timestamp', () => {
    const before = Date.now()
    const timing = startRunnerTiming({
      executionId: 'exec-1',
      agentId: 'agent-1',
      runnerType: 'squad-worker',
    })

    expect(timing).toMatchObject({
      executionId: 'exec-1',
      agentId: 'agent-1',
      runnerType: 'squad-worker',
    })
    expect(timing.enteredRunAt).toBeGreaterThanOrEqual(before)
    expect(timing.enteredRunAt).toBeLessThanOrEqual(Date.now())
  })

  test('accepts all runner milestones without throwing', () => {
    const timing = startRunnerTiming({
      executionId: 'exec-1',
      agentId: 'agent-1',
      runnerType: 'squad-manager',
    })

    expect(() => logRunnerMilestone(timing, 'started')).not.toThrow()
    expect(() => logRunnerMilestone(timing, 'session-ready')).not.toThrow()
    expect(() => logRunnerMilestone(timing, 'prompt-sent')).not.toThrow()
    expect(() => logRunnerMilestone(timing, 'first-output')).not.toThrow()
  })
})
