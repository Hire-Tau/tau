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
  /** The library preset the active custom document was applied from, or null
   * when detached (built-in selection, a one-off import, or the preset was
   * later deleted — the snapshot in `customTheme` keeps working either way). */
  presetId: string | null
}
export interface MyThemePreferences {
  userId: string
  /** No row means no account choice, not an instruction to upload this device's cache. */
  theme: ThemePreference | null
}

/** Validate atomically: never accept a custom document with a different base.
 * A v2 pair follows the Light/Dark/System toggle, so (unlike v1) the stored
 * appearance is not required to match a single concrete variant. */
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
    if (customTheme.base !== value.themeId) return { ok: false, error: 'Custom theme must match the selected base.' }
  }
  let presetId: string | null = null
  if (value.presetId !== undefined && value.presetId !== null) {
    if (typeof value.presetId !== 'string' || !value.presetId || value.presetId.length > 200)
      return { ok: false, error: 'Invalid presetId.' }
    presetId = value.presetId
  }
  return {
    ok: true,
    theme: { themeId: value.themeId as string, appearance: value.appearance, customTheme, presetId },
  }
}
