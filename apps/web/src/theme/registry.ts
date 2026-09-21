import {
  DEFAULT_THEME_ID,
  resolveThemeSelection,
  type EffectiveAppearance,
  type StoredThemeSelection,
  type ThemeDescriptor,
  type ThemeKind,
} from '@tau/shared'

/**
 * Web theme registry (phase 0). Exactly one built-in ships today: the `tau`
 * theme, whose two variants are byte-identical to today's light/dark scopes in
 * `src/index.css`. Its token values live in CSS (`:root` / `.dark`); this
 * registry only describes *how a resolved variant is applied to the document*,
 * so there is exactly one source of truth for color values.
 *
 * New built-in themes (phase 5) add entries here; unified themes (PD-6) use
 * `kind: 'unified'` with a single `constant` scope.
 */
export interface WebThemeDefinition extends ThemeDescriptor {
  readonly id: string
  readonly label: string
  readonly kind: ThemeKind
  /**
   * The class added to <html> per resolved variant (null = no class). The
   * light variant of `tau` uses the unscoped `:root` defaults, the dark
   * variant keeps the literal `dark` class so existing Tailwind `dark:`
   * variants keep working through the migration (report §4.1).
   */
  readonly variantClass: Partial<Record<EffectiveAppearance, string | null>>
}

/** The default dual-variant theme: today's light/dark look, unchanged. */
export const TAU_THEME: WebThemeDefinition = {
  id: 'tau',
  label: 'Tau',
  kind: 'dual',
  variantClass: { light: null, dark: 'dark' },
}

/** Built-in themes available without any custom-theme machinery. */
export const BUILT_IN_THEMES: readonly WebThemeDefinition[] = [TAU_THEME]

export function findWebTheme(themeId: string | null | undefined): WebThemeDefinition {
  return (
    BUILT_IN_THEMES.find((theme) => theme.id === themeId) ??
    BUILT_IN_THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)!
  )
}

export const KNOWN_THEME_IDS: readonly string[] = BUILT_IN_THEMES.map((theme) => theme.id)

export interface ResolvedWebTheme {
  readonly theme: WebThemeDefinition
  readonly appearance: EffectiveAppearance
}

/**
 * Resolve (themeId, appearance) with the shared fallback rules: unknown id →
 * default theme; unified ignores appearance; 'system' resolves against the OS
 * preference. Never derives colors.
 */
export function resolveWebTheme(
  themeId: string | null | undefined,
  appearance: StoredThemeSelection['appearance'] | null | undefined,
  systemPrefersDark: boolean
): ResolvedWebTheme {
  return resolveThemeSelection(BUILT_IN_THEMES, themeId, appearance, systemPrefersDark)
}
