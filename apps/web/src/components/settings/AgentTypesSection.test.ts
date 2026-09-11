import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentTypeUpdatePayload, type AgentTypeForm } from './AgentTypesSection'
import type { AgentTypeConfig } from '../../api/config'

const source = readFileSync(join(import.meta.dir, 'AgentTypesSection.tsx'), 'utf8')

describe('AgentTypesSection template revert refresh', () => {
  test('syncs expanded row form state when refreshed agent type data arrives', () => {
    expect(source.includes('useEffect')).toBe(true)
    expect(source.includes('setForm(agentTypeToForm(agentType))')).toBe(true)
  })

  test('renders inline template diff and revert controls for individual fields', () => {
    expect(source.includes('TemplateFieldActions')).toBe(true)
    expect(source.includes("fieldActions('model')")).toBe(true)
    expect(source.includes("fieldActions('systemPrompt')")).toBe(true)
    expect(source.includes('revertAgentTypeFields')).toBe(true)
  })
})

describe('ModelSpecListEditor add-model behavior', () => {
  test('keeps the spec list in local state so empty entries survive re-render', () => {
    // The bug: specs were derived from `value` with .filter(Boolean) on every
    // render, so a freshly added '' entry was stripped immediately. The fix
    // keeps specs in useState and only resyncs from the prop on external
    // changes (tracked via a ref of the last emitted value).
    expect(source.includes('const [specs, setSpecs] = useState')).toBe(true)
    expect(source.includes('lastEmitted')).toBe(true)
    // addSpec appends an empty string, which must remain visible.
    expect(source.includes("update([...specs, ''])")).toBe(true)
  })

  test('does not re-derive specs from value on every render', () => {
    // The old buggy code derived specs inline:
    //   const specs = value.split(',').map(...).filter(Boolean)
    // That line should no longer appear as the specs declaration.
    expect(source.includes('const specs = value')).toBe(false)
  })
})

describe('agent type save payload', () => {
  const agentType: AgentTypeConfig = {
    id: 'engineer',
    name: 'Engineer',
    model: '',
    tier: 'standard',
    description: 'Writes code',
    systemPrompt: 'You implement.',
    includes: ['rules', 'subagents', 'squad-rules'],
    skills: ['test-driven-development'],
    extensions: null,
    toolsAllow: null,
    toolsDeny: null,
    integrationCapabilities: null,
    disabled: false,
    yamlFieldOverrides: [],
    hasTemplate: true,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  }

  const form: AgentTypeForm = {
    systemOnly: false,
    name: 'Engineer',
    model: '',
    tier: 'standard',
    description: 'Writes code',
    systemPrompt: 'You implement.',
    skills: ['test-driven-development'],
    extensions: '',
    toolsAllow: '',
    toolsDeny: '',
    integrationAgentTools: false,
    integrationConversationExport: false,
  }

  // PUT replaces the whole row and the server now stores `includes`, so a form
  // that omits the field would silently strip a type's shared prompt blocks.
  test('carries the existing include list through an edit of another field', () => {
    const payload = agentTypeUpdatePayload({ ...form, description: 'Writes better code' }, agentType)
    expect(payload.includes).toEqual(['rules', 'subagents', 'squad-rules'])
    expect(payload.description).toBe('Writes better code')
  })

  test('sends an empty list for a type that has no includes', () => {
    expect(agentTypeUpdatePayload(form, { ...agentType, includes: [] }).includes).toEqual([])
  })
})
