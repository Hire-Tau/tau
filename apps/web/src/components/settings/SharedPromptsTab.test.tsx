import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharedPromptList, deleteErrorMessage } from './SharedPromptsTab'

const source = readFileSync(join(import.meta.dir, 'SharedPromptsTab.tsx'), 'utf8')

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

describe('SharedPromptsTab failure reporting', () => {
  // A rejected toggle or revert used to leave the card looking unchanged with
  // no explanation; every mutation now writes to the one error banner.
  test('routes every mutation failure into the shared action banner', () => {
    expect(source.split('onError: (error) => setActionError(deleteErrorMessage(error))').length - 1).toBe(4)
    expect(source.includes('{actionError && ')).toBe(true)
    expect(source.includes('setDeleteError')).toBe(false)
  })

  test('clears the banner when an editor opens, a save lands or a toggle lands', () => {
    // openEditor, openNew, save.onSuccess, toggle.onSuccess, remove.onSuccess,
    // and the delete confirm path all reset it.
    expect(source.split("setActionError('')").length - 1).toBe(6)
  })

  test('renders the edit modal only for operators who can write', () => {
    expect(source.includes('{canWrite && editing && (')).toBe(true)
  })
})
