import { expect, test } from 'bun:test'
import type { ThemePreference } from './theme-preferences'
import type { CustomThemeDocument } from './custom-theme'
import { STATUS_TOKENS } from './theme-schema'
import { validateThemePreference } from './theme-preferences'

const theme: ThemePreference = { themeId: 'harbor', appearance: 'dark', customTheme: null, presetId: null }
const custom: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 2,
  name: 'Shared',
  base: 'harbor',
  variants: { light: {}, dark: { '--term-bg': 'rgba(1,2,3,0.000000001)' } },
}
test('validates a complete preference including tiny-alpha custom values; strips unknown fields', () => {
  expect(validateThemePreference({ ...theme, userId: 'other' })).toEqual({ ok: true, theme })
  expect(validateThemePreference({ ...theme, customTheme: custom })).toEqual({
    ok: true,
    theme: { ...theme, customTheme: custom },
  })
  expect(
    validateThemePreference({
      themeId: 'high-contrast',
      appearance: 'system',
      customTheme: { ...custom, base: 'high-contrast', variants: { constant: {} } },
      presetId: null,
    }).ok
  ).toBe(true)
})
test('presetId is optional; when present it must be a non-empty string, defaulting to null when absent', () => {
  const { presetId: _drop, ...withoutPresetId } = theme
  expect(validateThemePreference(withoutPresetId)).toEqual({ ok: true, theme })
  const withPreset = { ...theme, presetId: '11111111-1111-4111-8111-111111111111' }
  expect(validateThemePreference(withPreset)).toEqual({ ok: true, theme: withPreset })
  expect(validateThemePreference({ ...theme, presetId: '' }).ok).toBe(false)
  expect(validateThemePreference({ ...theme, presetId: 123 }).ok).toBe(false)
})
test('a custom theme pair may resolve either side regardless of the current appearance (no forced match)', () => {
  // Previously appearance had to equal the document's single concrete appearance;
  // v2 pairs follow the Light/Dark/System toggle instead, so a 'light' appearance
  // with a dark-only-populated pair (and vice versa) is valid as long as the base matches.
  expect(validateThemePreference({ ...theme, appearance: 'light', customTheme: custom }).ok).toBe(true)
  expect(validateThemePreference({ ...theme, appearance: 'system', customTheme: custom }).ok).toBe(true)
})
test('rejects missing fields, unknowns, unsafe values, incoherent status sets, base/variant mismatch and oversized docs', () => {
  for (const input of [
    null,
    [],
    {},
    { ...theme, appearance: 'constant' },
    { ...theme, themeId: 'unknown' },
    { themeId: 'tau', appearance: 'dark' },
    ...[
      { ...custom, base: 'ember' },
      { ...custom, version: 3 },
      { ...custom, variants: { light: { '--term-bg': 'url(https://bad.test)' }, dark: {} } },
      { ...custom, variants: { light: {}, dark: { [STATUS_TOKENS[0]!]: '#123456' } } },
      { ...custom, extra: 'x'.repeat(40000) },
    ].map((doc) => ({ ...theme, customTheme: doc })),
  ]) {
    expect(validateThemePreference(input).ok).toBe(false)
  }
})
