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
/** A palette-derived document needs getComputedStyle to derive (see
 * applyCustomTheme below), which the synchronous pre-paint script cannot trust
 * yet — so it stores the LAST RESOLVED result here instead, keyed to the exact
 * (document, resolved appearance) pair. See readResolvedSnapshot/persistResolvedSnapshot. */
export const RESOLVED_SNAPSHOT_KEY = 'tau-custom-theme-resolved'
/** Generous but explicit safety cap: a full palette-derived theme can touch
 * most of the ~431-token registry (up to 3 compiled properties each), which a
 * real theme approaches but should never exceed by a wide margin. Exceeding
 * this just skips persisting (falls back to the explicit-overrides-only
 * pre-paint path) rather than growing localStorage unboundedly. */
export const RESOLVED_SNAPSHOT_MAX_BYTES = 200 * 1024

export function clearCustomTheme(storage: ThemeStorage | null) {
  for (const key of [
    CUSTOM_THEME_KEY,
    PRESET_ID_KEY,
    RESOLVED_SNAPSHOT_KEY,
    THEME_SURFACE_KEY,
    LEGACY_SURFACE_COLOR_KEY,
  ]) {
    try {
      storage?.removeItem(key)
    } catch {
      /* storage denied: still recover in memory */
    }
  }
}

/** Deterministic, non-cryptographic (staleness detection only) hash of a
 * custom theme document (FNV-1a over its normalized JSON). Shared by the
 * React paint path and the generated pre-paint bundle so both agree on
 * exactly when a stored resolved snapshot is stale — any change to the
 * document (a palette seed, an explicit override, even the name) changes it. */
export function hashCustomThemeDocument(doc: CustomThemeDocument): string {
  const json = JSON.stringify(doc)
  let hash = 0x811c9dc5 // FNV-1a 32-bit offset basis
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

interface ResolvedThemeSnapshot {
  docHash: string
  appearance: EffectiveAppearance
  vars: Record<string, string>
}

/** Persists the exact compiled vars `applyCustomTheme` just wrote to the root,
 * keyed to the document that produced them and the resolved appearance they
 * are for. Only ever called for the ACTIVE document (ThemeProvider's own root
 * paint) — never for a library preset that is not currently applied. */
export function persistResolvedSnapshot(
  storage: ThemeStorage | null,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance,
  vars: Record<string, string>
): void {
  try {
    const snapshot: ResolvedThemeSnapshot = { docHash: hashCustomThemeDocument(doc), appearance, vars }
    const raw = JSON.stringify(snapshot)
    if (new TextEncoder().encode(raw).length > RESOLVED_SNAPSHOT_MAX_BYTES) return
    storage?.setItem(RESOLVED_SNAPSHOT_KEY, raw)
  } catch {
    /* best-effort: the next real paint still derives correctly */
  }
}

/** Reads a resolved snapshot only when it exactly matches this document and
 * appearance; a different document (edited elsewhere), a different resolved
 * side (e.g. a 'system' OS flip with no snapshot for that side), corrupt
 * JSON, or no snapshot at all all return null — callers fall back to the
 * explicit-overrides-only pre-paint path. Property names are filtered to the
 * registry-owned set (custom.ts's only write surface) before use, even though
 * this key is same-origin-only: defense in depth, matching applyCustomTheme's
 * own "only individually validated, registry-owned properties" contract. */
export function readResolvedSnapshot(
  storage: ThemeStorage | null,
  doc: CustomThemeDocument,
  appearance: EffectiveAppearance
): Record<string, string> | null {
  try {
    const raw = storage?.getItem(RESOLVED_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ResolvedThemeSnapshot>
    if (
      !parsed ||
      typeof parsed.docHash !== 'string' ||
      parsed.docHash !== hashCustomThemeDocument(doc) ||
      parsed.appearance !== appearance ||
      !parsed.vars ||
      typeof parsed.vars !== 'object'
    )
      return null
    const vars: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed.vars))
      if (customProperties.has(name) && typeof value === 'string') vars[name] = value
    return vars
  } catch {
    return null
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
): Record<string, string> {
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
  // Returned so the root-paint caller (ThemeProvider) can persist exactly
  // these resolved vars as a pre-paint snapshot for the next cold load.
  return variables
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
