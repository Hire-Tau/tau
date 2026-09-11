import { expect, test } from 'bun:test'
import { SQUAD_TABS, SQUAD_SETTINGS_SECTIONS } from '../lib/squadNavigation'
import { ALL_SECTIONS } from '../components/settings/settingsSections'
import { visibleNavItems } from '../components/navModel'
import { buildVoiceNavigationGuide } from './navigationGuide'
import { navigationTool } from './tools/navigationTool'

test('voice navigation follows the shared UI definitions and canonical squad paths', () => {
  const guide = buildVoiceNavigationGuide()
  expect(navigationTool.definition.description).toBe(guide)
  for (const tab of SQUAD_TABS) expect(guide).toContain(`${tab.label}: /squads/:squadId/${tab.path}`)
  for (const section of SQUAD_SETTINGS_SECTIONS)
    expect(guide).toContain(`/squads/:squadId/settings?section=${section.id}`)
  for (const section of ALL_SECTIONS) expect(guide).toContain(`${section.label}: /settings?section=${section.id}`)
  for (const item of visibleNavItems) expect(guide).toContain(`${item.label}: ${item.to}`)
  expect(guide).toContain('Chats: /squads/:squadId/agents')
  expect(guide).toContain('/squads/:squadId/work?ws=:workStreamId')
  expect(guide).not.toContain('/chat — Chat list')
  expect(guide).not.toContain('bottom-right')
})

test('settings navigation includes a description for every destination without implying access to form values', () => {
  const guide = buildVoiceNavigationGuide()
  for (const section of ALL_SECTIONS) {
    expect(section.description.length).toBeGreaterThan(10)
    expect(guide).toContain(section.description)
  }
  expect(guide).toContain('not live form values')
})
