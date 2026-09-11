import { describe, expect, it } from 'bun:test'
import { auditActor } from './audit-actor'

describe('auditActor', () => {
  it('identifies the system token responsible for a change', () => {
    expect(
      auditActor({
        type: 'system',
        systemTokenId: '00000000-0000-4000-8000-000000000001',
        name: 'platform-orchestrator',
        scopes: [],
      })
    ).toBe('system-token:00000000-0000-4000-8000-000000000001')
  })
})
