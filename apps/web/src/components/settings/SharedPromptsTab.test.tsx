import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharedPromptList, deleteErrorMessage } from './SharedPromptsTab'

describe('SharedPromptList', () => {
  test('shows name, id, drift and disabled state per include', () => {
    const html = renderToStaticMarkup(
      <SharedPromptList
        includes={
          [
            {
              id: 'rules',
              name: 'Rules',
              description: 'Shell safety',
              yamlFieldOverrides: ['content'],
              hasTemplate: true,
              disabled: false,
            },
            { id: 'old', name: 'Old', description: null, yamlFieldOverrides: [], hasTemplate: false, disabled: true },
          ] as any
        }
        onEdit={() => {}}
        onToggle={() => {}}
        onDelete={() => {}}
        canWrite
      />
    )
    expect(html).toContain('Rules')
    expect(html).toContain('rules')
    expect(html).toContain('Modified from template')
    expect(html).toContain('Disabled')
  })

  test('offers Delete only for includes with no template', () => {
    const html = renderToStaticMarkup(
      <SharedPromptList
        includes={
          [
            {
              id: 'rules',
              name: 'Rules',
              description: null,
              yamlFieldOverrides: [],
              hasTemplate: true,
              disabled: false,
            },
          ] as any
        }
        onEdit={() => {}}
        onToggle={() => {}}
        onDelete={() => {}}
        canWrite
      />
    )
    expect(html).not.toContain('Delete')
  })
})

describe('deleteErrorMessage', () => {
  // A 409 body names the agent types still referencing the include; dropping
  // referencedBy would leave the operator with no way to find the blockers.
  test('appends the referencing agent type ids from a 409 payload', () => {
    const error = Object.assign(new Error('API error: 409: Shared prompt "rules" is used by agent types'), {
      payload: { error: 'Shared prompt "rules" is used by agent types', referencedBy: ['engineer', 'manager'] },
    })
    expect(deleteErrorMessage(error)).toBe(
      'API error: 409: Shared prompt "rules" is used by agent types — used by: engineer, manager'
    )
  })

  test('passes a plain error through unchanged', () => {
    expect(deleteErrorMessage(new Error('boom'))).toBe('boom')
  })
})
