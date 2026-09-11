import { describe, expect, test } from 'bun:test'
import { agentStatusSchema } from './schemas'
import { AGENT_STATUSES, isAddressableAgentStatus, isLiveAgentStatus } from './types'

describe('isLiveAgentStatus', () => {
  test('classifies every status exhaustively', () => {
    expect(Object.fromEntries(AGENT_STATUSES.map((status) => [status, isLiveAgentStatus(status)]))).toEqual({
      idle: true,
      active: true,
      'waiting-input': true,
      compacting: true,
      resetting: true,
      dormant: false,
      terminated: false,
    })
  })

  test('classifies dormant and terminated as non-live', () => {
    expect(isLiveAgentStatus('dormant')).toBe(false)
    expect(isLiveAgentStatus('terminated')).toBe(false)
  })

  test('keeps dormant addressable but excludes terminated', () => {
    expect(isAddressableAgentStatus('dormant')).toBe(true)
    expect(isAddressableAgentStatus('terminated')).toBe(false)
  })

  test('derives API validation from the canonical inventory', () => {
    expect(agentStatusSchema.options).toEqual([...AGENT_STATUSES])
    expect(AGENT_STATUSES.every((status) => agentStatusSchema.safeParse(status).success)).toBe(true)
  })
})
