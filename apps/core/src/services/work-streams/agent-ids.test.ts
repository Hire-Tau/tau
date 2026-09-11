import { describe, expect, it } from 'bun:test'
import { collectWorkStreamAgentIds } from './agent-ids'

describe('collectWorkStreamAgentIds', () => {
  it('returns assignee plus members exactly once in stable order', () => {
    expect(
      collectWorkStreamAgentIds({
        assigneeAgentId: 'assignee',
        agentIds: ['member', 'assignee', 'member'],
      })
    ).toEqual(['assignee', 'member'])
  })
})
