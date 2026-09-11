import { describe, expect, it } from 'bun:test'

import { buildListAgentsPath } from './agents'

describe('listAgents subagent filters', () => {
  it('serializes parentAgentId into the query string', () => {
    expect(buildListAgentsPath({ parentAgentId: 'parent-1' })).toContain('parentAgentId=parent-1')
  })

  it('serializes topLevelOnly=true', () => {
    expect(buildListAgentsPath({ topLevelOnly: true })).toContain('topLevelOnly=true')
  })
})
