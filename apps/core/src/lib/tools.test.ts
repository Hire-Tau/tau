import { describe, expect, test } from 'bun:test'
import { filterToolsByPolicy } from './tools'

describe('filterToolsByPolicy', () => {
  test('applies allow patterns while giving deny patterns precedence', () => {
    const tools = [{ name: 'read' }, { name: 'write' }, { name: 'squad_bash' }]

    expect(filterToolsByPolicy(tools, ['read', 'squad_*'], ['squad_bash']).map((tool) => tool.name)).toEqual(['read'])
  })
})
