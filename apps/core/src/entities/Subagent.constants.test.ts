import { describe, it, expect } from 'bun:test'
import {
  SUBAGENT_AGENT_TYPE_ID,
  SUBAGENT_RUNNER_TYPE,
  SUBAGENT_MAX_PER_PARENT,
  SUBAGENT_WATCHDOG_KIND,
  SUBAGENT_WATCHDOG_INTERVAL_MINUTES,
} from './Subagent'

describe('Subagent constants', () => {
  it('exposes the agreed constant values', () => {
    expect(SUBAGENT_AGENT_TYPE_ID).toBe('subagent')
    expect(SUBAGENT_RUNNER_TYPE).toBe('subagent')
    expect(SUBAGENT_MAX_PER_PARENT).toBe(10)
    expect(SUBAGENT_WATCHDOG_KIND).toBe('subagent-watchdog')
    expect(SUBAGENT_WATCHDOG_INTERVAL_MINUTES).toBe(15)
  })
})
