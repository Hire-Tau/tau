import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import { agentTypes, promptIncludes } from './schema'

describe('prompt includes schema', () => {
  test('prompt_includes carries the template/override columns every synced domain has', () => {
    const cols = Object.keys(getTableColumns(promptIncludes))
    for (const c of [
      'id',
      'name',
      'description',
      'content',
      'yamlTemplate',
      'yamlFieldOverrides',
      'disabled',
      'createdAt',
      'updatedAt',
    ])
      expect(cols).toContain(c)
  })
  test('agent_types has an ordered includes list', () => {
    expect(Object.keys(getTableColumns(agentTypes))).toContain('includes')
  })
})
