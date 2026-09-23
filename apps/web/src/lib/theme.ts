/** A person's appearance choice. `system` follows the OS light/dark setting. */
export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/**
 * localStorage key for the preference. index.html's pre-render script reads the
 * same key (and repeats defaultThemePreference) so the first paint has the right
 * theme; keep the two in step.
 */
export const THEME_STORAGE_KEY = 'tau-theme'
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export function parseThemePreference(value: string | null | undefined): ThemePreference | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null
}

/**
 * The preference before anyone chooses one. Tau Desktop's own setup and startup
 * screens follow the OS appearance, so inside it the app does too instead of
 * flashing to light. Browsers keep the long-standing light default.
 */
export function defaultThemePreference(inDesktop: boolean): ThemePreference {
  return inDesktop ? 'system' : 'light'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}
