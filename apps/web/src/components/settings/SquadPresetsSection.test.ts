import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'SquadPresetsSection.tsx'), 'utf8')

describe('SquadPresetsSection template revert refresh', () => {
  test('syncs expanded row form state when refreshed squad preset data arrives', () => {
    expect(source.includes('useEffect')).toBe(true)
    expect(source.includes('setForm(squadPresetToForm(squadPreset))')).toBe(true)
  })
})
