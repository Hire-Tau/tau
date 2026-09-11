import { describe, expect, test } from 'bun:test'
import { buildVoiceInstructions, type VoiceSessionContext } from './assistants/siteOperator/siteOperatorInstructions'

const baseContext: VoiceSessionContext = {
  systemManagerId: 'system-manager-agent',
  squads: [],
  currentPath: '/settings?chat=open',
}

describe('buildVoiceInstructions', () => {
  test('includes current visible agent from Assistant text conversation', () => {
    const instructions = buildVoiceInstructions({
      ...baseContext,
      visibleAgents: [{ id: 'drawer-agent-id', source: 'system-manager-chat-drawer' }],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Primary visible agent source: Assistant text conversation')
  })

  test('identifies the squad coordinator without claiming an open conversation', () => {
    const instructions = buildVoiceInstructions({
      systemManagerId: 'system-manager-agent',
      currentPath: '/squads/squad-1?tab=home',
      squads: [
        {
          id: 'squad-1',
          name: 'Engineering',
          purpose: 'Build things',
          status: 'active',
          agents: [{ id: 'manager-agent-id', agentTypeId: 'manager', status: 'idle' }],
        },
      ],
    })

    expect(instructions).toContain('Current squad manager ID: manager-agent-id')
    expect(instructions).not.toContain('Current primary visible agent ID: manager-agent-id')
    expect(instructions).not.toContain('Primary visible agent source: main page agent thread')
    expect(instructions).not.toContain('Visible agent (manager thread on home tab)')
  })

  test('keeps the coordinator distinct from an open Assistant conversation', () => {
    const instructions = buildVoiceInstructions({
      systemManagerId: 'system-manager-agent',
      currentPath: '/squads/squad-1?tab=home',
      visibleAgents: [{ id: 'drawer-agent-id', source: 'system-manager-chat-drawer' }],
      squads: [
        {
          id: 'squad-1',
          name: 'Engineering',
          purpose: 'Build things',
          status: 'active',
          agents: [{ id: 'manager-agent-id', agentTypeId: 'manager', status: 'idle' }],
        },
      ],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Current squad manager ID: manager-agent-id')
    expect(instructions).not.toContain('- manager-agent-id (main page agent thread)')
  })

  test('includes secondary visible agents and disambiguation rules', () => {
    const instructions = buildVoiceInstructions({
      ...baseContext,
      visibleAgents: [
        { id: 'drawer-agent-id', source: 'system-manager-chat-drawer' },
        { id: 'page-agent-id', source: 'url' },
      ],
    })

    expect(instructions).toContain('Current primary visible agent ID: drawer-agent-id')
    expect(instructions).toContain('Other visible agent IDs:')
    expect(instructions).toContain('- page-agent-id (main page agent thread)')
    expect(instructions).toContain(
      'If multiple agents are visible and the request could apply to either, ask a short clarification.'
    )
  })
})

test('resolves the current squad slug and supplies full tool IDs', () => {
  const squadId = '11111111-1111-1111-1111-111111111111'
  const managerId = '22222222-2222-2222-2222-222222222222'
  const instructions = buildVoiceInstructions({
    systemManagerId: null,
    currentPath: '/squads/tau',
    squads: [
      {
        id: squadId,
        name: 'Tau',
        purpose: null,
        status: 'active',
        createdAt: '2026-01-01',
        agents: [{ id: managerId, agentTypeId: 'manager', status: 'idle' }],
      },
    ],
  })
  expect(instructions).toContain(`Current squad ID: ${squadId}`)
  expect(instructions).toContain(`Current squad manager ID: ${managerId}`)
  expect(instructions).toContain(`manager: ${managerId}`)
  expect(instructions).not.toContain('Current squad ID: tau')
})

test('new incidents use squad purpose for immediate handoff without requiring an existing work stream', () => {
  const instructions = buildVoiceInstructions({
    ...baseContext,
    squads: [
      {
        id: 'dao-squad',
        name: 'DAO DAO',
        purpose: 'Manage the DAO DAO platform',
        status: 'active',
        agents: [{ id: 'dao-manager', agentTypeId: 'manager', status: 'idle' }],
      },
    ],
  })
  expect(instructions).toContain('DAO DAO** (id: dao-squad, manager: dao-manager): Manage the DAO DAO platform')
  expect(instructions).toContain('call message_squad_manager immediately')
  expect(instructions).toContain('A new report does not need an existing work stream')
  expect(instructions).toContain('Do not offer a troubleshooting checklist')
  expect(instructions).toContain('exact URLs')
  expect(instructions).toContain('Respect explicit requests to brainstorm or discuss before sending anything')
  expect(instructions).toContain('If no squad clearly fits, delegate routing to message_user_assistant')
})

test('global settings retain user-assistant routing while viewing a squad', () => {
  const instructions = buildVoiceInstructions({
    ...baseContext,
    currentPath: '/squads/source',
    squads: [
      {
        id: 'source',
        name: 'Source',
        purpose: 'Manage Source project configuration',
        status: 'active',
        agents: [{ id: 'source-manager', agentTypeId: 'manager', status: 'idle' }],
      },
    ],
  })
  expect(instructions).toContain('Current squad manager ID: source-manager')
  expect(instructions).toContain('Route global or personal Tau administration to message_user_assistant')
  expect(instructions).toContain('delete GITHUB_TOKEN and GITHUB_TOKEN_NOAHSASO env vars')
  expect(instructions).toContain('goes to message_user_assistant even while viewing Source')
  expect(instructions).toContain('send that recipient a correction to stop that request')
  expect(instructions).not.toContain('For new reports and work requests, use message_squad_manager;')
})
