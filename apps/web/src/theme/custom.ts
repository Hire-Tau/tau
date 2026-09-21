import {
  ACTIVE_THEME_TOKENS,
  CUSTOM_THEME_MAX_BYTES,
  compileCustomTheme,
  validateCustomTheme,
  type CustomThemeDocument,
  type StoredThemeSelection,
} from '@tau/shared'
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

export function clearCustomTheme(storage: ThemeStorage | null) {
  for (const key of [CUSTOM_THEME_KEY, THEME_SURFACE_KEY, LEGACY_SURFACE_COLOR_KEY]) {
    try {
      storage?.removeItem(key)
    } catch {
      /* storage denied: still recover in memory */
    }
  }
}

export function customSelection(doc: CustomThemeDocument, previous: StoredThemeSelection): StoredThemeSelection {
  return { themeId: doc.base, appearance: doc.appearance === 'constant' ? previous.appearance : doc.appearance }
}

export function loadCustomTheme(storage: ThemeStorage | null): {
  selection: StoredThemeSelection
  custom: CustomThemeDocument | null
  error: string | null
} {
  let selection = readThemeSelection(storage)
  let raw: string | null = null
  try {
    raw = storage?.getItem(CUSTOM_THEME_KEY) ?? null
  } catch {
    /* unavailable */
  }
  if (raw === null) return { selection, custom: null, error: null }
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  if (result.ok)
    return {
      selection: customSelection(result.document, selection),
      custom: result.document,
      error: result.warnings.join(' ') || null,
    }
  // A broken but readable document may still name a valid recovery base.
  // Do not parse oversized input a second time, and never trust its colors.
  if (new TextEncoder().encode(raw).length <= CUSTOM_THEME_MAX_BYTES) {
    try {
      const doc = JSON.parse(raw)
      const base = BUILT_IN_THEMES.find((theme) => theme.id === doc?.base)
      if (base) selection = { themeId: base.id, appearance: doc.appearance === 'dark' ? 'dark' : 'light' }
    } catch {
      /* retain the last safe built-in selection */
    }
  }
  clearCustomTheme(storage)
  persistThemeSelection(storage, selection)
  return { selection, custom: null, error: `Custom theme removed: ${result.error}` }
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
 * Names and values are revalidated; no CSS text or HTML construction exists. */
export function applyCustomTheme(element: HTMLElement, doc: CustomThemeDocument) {
  const variables = compileCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
  removeCustomProperties(element)
  applyResolvedTheme(element, findWebTheme(doc.base), doc.appearance)
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
  if (file.size > CUSTOM_THEME_MAX_BYTES) return { ok: false as const, error: 'Theme document exceeds 8 KiB.' }
  return validateCustomTheme(await file.text(), BUILT_IN_THEMES)
}
