import { describe, expect, test } from 'bun:test'
import {
  getAgentConversationStatusRefetchInterval,
  getAgentConversationMessagesRefetchInterval,
  VISIBLE_AGENT_REFETCH_INTERVAL_MS,
} from './agentConversationPolling'

describe('agent conversation polling', () => {
  test('polls visible agent status even when websocket is connected so missed events self-heal', () => {
    expect(getAgentConversationStatusRefetchInterval({ wsConnected: true })).toBe(VISIBLE_AGENT_REFETCH_INTERVAL_MS)
  })

  test('polls messages while an execution is active', () => {
    expect(getAgentConversationMessagesRefetchInterval({ activeExecution: { active: true, status: 'running' } })).toBe(
      VISIBLE_AGENT_REFETCH_INTERVAL_MS
    )
  })

  test('does not poll messages once no execution is active', () => {
    expect(getAgentConversationMessagesRefetchInterval({ activeExecution: { active: false } })).toBe(false)
  })
})
