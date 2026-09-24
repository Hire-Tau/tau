import { ACTIVE_THEME_TOKENS, type EffectiveAppearance, type StoredThemeSelection } from '@tau/shared/theme-schema'
import {
  CUSTOM_THEME_MAX_BYTES,
  compileCustomTheme,
  validateCustomTheme,
  type CustomThemeDocument,
} from '@tau/shared/custom-theme'
import { applyResolvedTheme } from './apply'
import { BUILT_IN_THEMES, findWebTheme } from './registry'
import {
  LEGACY_SURFACE_COLOR_KEY,
  THEME_SURFACE_KEY,
  persistThemeSelection,
  readThemeSelection,
  type ThemeStorage,
} from './storage'

export const CUSTOM_THEME_KEY = 'tau-custom-theme'
/** Device-local only (not part of pre-paint): remembers which library preset the
 * active document came from, so the UI can restore the ring/active state on reload
 * without a network round-trip. A dangling value (deleted preset) is harmless —
 * callers treat an unmatched id as detached. */
export const PRESET_ID_KEY = 'tau-theme-preset-id'

export function clearCustomTheme(storage: ThemeStorage | null) {
  for (const key of [CUSTOM_THEME_KEY, PRESET_ID_KEY, THEME_SURFACE_KEY, LEGACY_SURFACE_COLOR_KEY]) {
    try {
      storage?.removeItem(key)
    } catch {
      /* storage denied: still recover in memory */
    }
  }
}

/** A v2 document covers both variants, so applying it never forces a particular
 * appearance — only its base theme id changes the selection. */
export function customSelection(doc: CustomThemeDocument, previous: StoredThemeSelection): StoredThemeSelection {
  return { themeId: doc.base, appearance: previous.appearance }
}

export function readPresetId(storage: ThemeStorage | null): string | null {
  try {
    return storage?.getItem(PRESET_ID_KEY) ?? null
  } catch {
    return null
  }
}

export function persistPresetId(storage: ThemeStorage | null, presetId: string | null) {
  try {
    if (presetId) storage?.setItem(PRESET_ID_KEY, presetId)
    else storage?.removeItem(PRESET_ID_KEY)
  } catch {
    /* device-local in memory */
  }
}

export function loadCustomTheme(storage: ThemeStorage | null): {
  selection: StoredThemeSelection
  custom: CustomThemeDocument | null
  presetId: string | null
  error: string | null
} {
  let selection = readThemeSelection(storage)
  let raw: string | null = null
  try {
    raw = storage?.getItem(CUSTOM_THEME_KEY) ?? null
  } catch {
    /* unavailable */
  }
  if (raw === null) return { selection, custom: null, presetId: null, error: null }
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  if (result.ok)
    return {
      selection: customSelection(result.document, selection),
      custom: result.document,
      presetId: readPresetId(storage),
      error: result.warnings.join(' ') || null,
    }
  // A broken but readable document may still name a valid recovery base.
  // Do not parse oversized input a second time, and never trust its colors.
  if (new TextEncoder().encode(raw).length <= CUSTOM_THEME_MAX_BYTES) {
    try {
      const doc = JSON.parse(raw)
      const base = BUILT_IN_THEMES.find((theme) => theme.id === doc?.base)
      if (base) selection = { themeId: base.id, appearance: selection.appearance }
    } catch {
      /* retain the last safe built-in selection */
    }
  }
  clearCustomTheme(storage)
  persistThemeSelection(storage, selection)
  return { selection, custom: null, presetId: null, error: `Custom theme removed: ${result.error}` }
}

export function persistCustomTheme(storage: ThemeStorage | null, doc: CustomThemeDocument): boolean {
  const raw = JSON.stringify(doc)
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  try {
    if (!storage) return false
    storage.setItem(CUSTOM_THEME_KEY, JSON.stringify(result.document))
    return true
  } catch {
    return false
  }
}

const customProperties = new Set(
  ACTIVE_THEME_TOKENS.flatMap((token) => [token, `--custom-rgb-${token.slice(2)}`, `--custom-alpha-${token.slice(2)}`])
)
const propertyNames = (element: HTMLElement) =>
  Array.from({ length: element.style.length }, (_, i) => element.style.item(i))

export function removeCustomProperties(element: HTMLElement) {
  for (const name of propertyNames(element)) if (customProperties.has(name)) element.style.removeProperty(name)
  if (element.hasAttribute('data-theme-scope')) {
    // Only compiler helpers can exist inline. Mask actual ancestor overrides,
    // rather than writing hundreds of unnecessary declarations on each edit.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      for (const name of propertyNames(ancestor)) {
        if (name.startsWith('--custom-') && customProperties.has(name)) element.style.setProperty(name, 'initial')
      }
    }
  }
}

/** The ONLY custom-color DOM write path. Both preview and root use this function.
 * Names and values are revalidated (the application boundary, not just file-open
 * time); no CSS text or HTML construction exists. `appearance` picks the resolved
 * variant (light/dark/'system' already resolved by the caller, or 'constant'). */
export function applyCustomTheme(
  element: HTMLElement,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance,
  options?: { deriveFromComputedStyle?: boolean }
) {
  const result = validateCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  removeCustomProperties(element)
  applyResolvedTheme(element, findWebTheme(doc.base), appearance)
  // A palette derives most tokens from the base theme's OWN resolved values
  // (getComputedStyle), so the plain base must paint first. Callers that
  // cannot trust the cascade yet (the synchronous pre-paint flash script,
  // before CSS is guaranteed loaded) pass deriveFromComputedStyle: false —
  // explicit `variants` overrides still apply either way.
  const deriveFromComputedStyle = options?.deriveFromComputedStyle ?? true
  const baseTokens = result.document.palette && deriveFromComputedStyle ? readPreviewTokens(element) : undefined
  const variables = compileCustomTheme(result.document, appearance, baseTokens)
  try {
    for (const [token, channels] of Object.entries(variables)) element.style.setProperty(token, channels)
  } catch (error) {
    removeCustomProperties(element)
    throw error
  }
}

/** Contrast uses computed base values (fractional channels, aliases, sentinels
 * and intrinsic alpha intact). Input colors never change opacity metadata. */
export function readPreviewTokens(element: HTMLElement): Record<string, string> {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  return Object.fromEntries(
    ACTIVE_THEME_TOKENS.flatMap((token) => {
      const opacity = `--opacity-${token.replace(/^--(?:color-)?/, '')}`
      return [
        [token, style.getPropertyValue(token).trim()],
        [opacity, style.getPropertyValue(opacity).trim() || '1'],
      ]
    })
  )
}

export function exportCustomTheme(doc: CustomThemeDocument): string {
  const result = validateCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
  if (!result.ok) throw new Error(result.error)
  // Compact serialization keeps even a near-limit imported file re-importable.
  return JSON.stringify(result.document)
}

export async function importCustomTheme(file: Pick<File, 'size' | 'text'>) {
  if (file.size > CUSTOM_THEME_MAX_BYTES)
    return { ok: false as const, error: `Theme document exceeds ${CUSTOM_THEME_MAX_BYTES / 1024} KiB.` }
  return validateCustomTheme(await file.text(), BUILT_IN_THEMES)
}
