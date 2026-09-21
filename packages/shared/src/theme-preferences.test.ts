import { expect, test } from 'bun:test'
import type { ThemePreference } from './theme-preferences'
import type { CustomThemeDocument } from './custom-theme'
import { STATUS_TOKENS } from './theme-schema'
import { validateThemePreference } from './theme-preferences'

const theme: ThemePreference = { themeId: 'harbor', appearance: 'dark', customTheme: null }
const custom: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 1,
  name: 'Shared',
  base: 'harbor',
  appearance: 'dark',
  overrides: { '--term-bg': 'rgba(1,2,3,0.000000001)' },
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
      customTheme: { ...custom, base: 'high-contrast', appearance: 'constant' },
    }).ok
  ).toBe(true)
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
      { ...custom, appearance: 'light' },
      { ...custom, version: 2 },
      { ...custom, overrides: { '--term-bg': 'url(https://bad.test)' } },
      { ...custom, overrides: { [STATUS_TOKENS[0]!]: '#123456' } },
      { ...custom, extra: 'x'.repeat(8192) },
    ].map((doc) => ({ ...theme, customTheme: doc })),
  ]) {
    expect(validateThemePreference(input).ok).toBe(false)
  }
})
