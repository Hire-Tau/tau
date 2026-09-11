import { describe, it, expect } from 'bun:test'
import { interpolateTemplate } from './prompt-builder'

describe('interpolateTemplate', () => {
  it('replaces simple placeholders', () => {
    const result = interpolateTemplate('Hello {{name}}!', { name: 'World' })
    expect(result).toBe('Hello World!')
  })

  it('replaces dotted placeholders', () => {
    const result = interpolateTemplate('Agent: {{agent.id}}, Squad: {{squad.name}}', {
      'agent.id': 'abc-123',
      'squad.name': 'Backend Squad',
    })
    expect(result).toBe('Agent: abc-123, Squad: Backend Squad')
  })

  it('replaces multiple occurrences of the same placeholder', () => {
    const result = interpolateTemplate('{{id}} and {{id}}', { id: 'foo' })
    expect(result).toBe('foo and foo')
  })

  it('leaves unresolved placeholders as-is', () => {
    const result = interpolateTemplate('Hello {{unknown}}!', {})
    expect(result).toBe('Hello {{unknown}}!')
  })

  it('handles empty values', () => {
    const result = interpolateTemplate('before\n\n{{empty}}\n\nafter', { empty: '' })
    expect(result).toBe('before\n\nafter')
  })

  it('collapses runs of 3+ newlines', () => {
    const result = interpolateTemplate('a\n\n\n\nb', {})
    expect(result).toBe('a\n\nb')
  })

  it('trims whitespace in placeholder keys', () => {
    const result = interpolateTemplate('{{ name }}', { name: 'hi' })
    expect(result).toBe('hi')
  })

  it('handles multiline values', () => {
    const result = interpolateTemplate('Before\n{{section}}\nAfter', {
      section: '## Section\n- item 1\n- item 2',
    })
    expect(result).toBe('Before\n## Section\n- item 1\n- item 2\nAfter')
  })
})
