import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ALL_SECTIONS } from './settingsSections'
import { SQUAD_SETTINGS_SECTIONS } from '../../lib/squadNavigation'
import { SETTINGS_SECTION_ICONS } from './settingsIcons'

for (const [name, sections] of [
  ['global', ALL_SECTIONS],
  ['squad', SQUAD_SETTINGS_SECTIONS],
] as const) {
  test(`${name} settings pages each have an explicit, visually unique icon`, () => {
    const rendered = sections.map(({ id }) => {
      const Icon = SETTINGS_SECTION_ICONS[id as keyof typeof SETTINGS_SECTION_ICONS]
      expect(Icon).toBeDefined()
      return renderToStaticMarkup(<Icon />)
    })
    expect(new Set(rendered).size).toBe(sections.length)
  })
}
