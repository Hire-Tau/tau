import { isAppearanceSetting, type StoredThemeSelection, type ThemeDescriptor } from './theme-schema'
import { validateCustomTheme, type CustomThemeDocument } from './custom-theme'

/** Cross-platform metadata only; palettes and variant classes remain web-owned. */
export const SYNC_THEME_DESCRIPTORS: readonly ThemeDescriptor[] = [
  { id: 'tau', label: 'Tau', kind: 'dual' },
  { id: 'harbor', label: 'Harbor', kind: 'dual' },
  { id: 'ember', label: 'Ember', kind: 'dual' },
  { id: 'high-contrast', label: 'High contrast', kind: 'unified' },
]

export interface ThemePreference extends StoredThemeSelection {
  customTheme: CustomThemeDocument | null
}
export interface MyThemePreferences {
  userId: string
  /** No row means no account choice, not an instruction to upload this device's cache. */
  theme: ThemePreference | null
}

/** Validate atomically: never accept a custom document with a different base/variant. */
export function validateThemePreference(
  input: unknown
): { ok: true; theme: ThemePreference } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'Expected a theme object.' }
  const value = input as Record<string, unknown>
  if (!SYNC_THEME_DESCRIPTORS.some((theme) => theme.id === value.themeId) || !isAppearanceSetting(value.appearance))
    return { ok: false, error: 'Unknown theme or appearance.' }
  let customTheme: CustomThemeDocument | null = null
  if (value.customTheme !== null) {
    const result = validateCustomTheme(JSON.stringify(value.customTheme) ?? '', SYNC_THEME_DESCRIPTORS)
    if (!result.ok) return result
    customTheme = result.document
    if (
      customTheme.base !== value.themeId ||
      (customTheme.appearance !== 'constant' && customTheme.appearance !== value.appearance)
    )
      return { ok: false, error: 'Custom theme must match the selected base and appearance.' }
  }
  return { ok: true, theme: { themeId: value.themeId as string, appearance: value.appearance, customTheme } }
}
