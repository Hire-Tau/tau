import {
  ACTIVE_THEME_TOKENS,
  THEME_TOKEN_NAMES,
  validateThemeTokenOverrides,
  type EffectiveAppearance,
  type ThemeDescriptor,
} from './theme-schema'

export const CUSTOM_THEME_MAX_BYTES = 8 * 1024
export interface CustomThemeDocument {
  format: 'tau-custom-theme'
  version: 1
  name: string
  base: string
  appearance: EffectiveAppearance
  overrides: Record<string, string>
}
export type CustomThemeValidation =
  | { ok: true; document: CustomThemeDocument; warnings: string[] }
  | { ok: false; error: string }

/** Closed color grammar: integer RGB channels, optional unit-interval alpha.
 * No CSS parser, URLs, references, percentages, exponents or arbitrary functions.
 * Internal built-in channels/sentinels are inherited, never imported as values. */
export function customColorChannels(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const color = value.trim()
  const hex = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(color)
  if (hex) {
    const digits = color.slice(1)
    const expanded = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
    const parts = expanded.match(/../g)!.map((d) => parseInt(d, 16))
    return parts.slice(0, 3).join(' ') + (parts.length === 4 ? ` / ${parts[3]! / 255}` : '')
  }
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+|1\.0+))?\s*\)$/.exec(
    color
  )
  if (!match || (match[1] === 'rgba') !== (match[5] !== undefined)) return null
  const rgb = match.slice(2, 5).map(Number)
  if (rgb.some((n) => n > 255)) return null
  return rgb.join(' ') + (match[5] === undefined ? '' : ` / ${Number(match[5])}`)
}

/** The string boundary is intentional: byte cap BEFORE JSON.parse, on every path. */
export function validateCustomTheme(raw: string, builtins: readonly ThemeDescriptor[]): CustomThemeValidation {
  const fail = (error: string): CustomThemeValidation => ({ ok: false, error })
  if (new TextEncoder().encode(raw).length > CUSTOM_THEME_MAX_BYTES) return fail('Theme document exceeds 8 KiB.')
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return fail('Theme document must be valid JSON.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Theme document must be an object.')
  const doc = input as Record<string, unknown>
  if (doc.format !== 'tau-custom-theme') return fail('Expected format tau-custom-theme.')
  if (doc.version !== 1) return fail('Unsupported theme version. This app supports version 1 only.')
  if (typeof doc.name !== 'string' || !doc.name.trim() || [...doc.name].length > 40)
    return fail('Theme name must be 1–40 characters.')
  const base = builtins.find((theme) => theme.id === doc.base)
  if (!base) return fail('Choose a known built-in base theme.')
  if (base.kind === 'unified' ? doc.appearance !== 'constant' : doc.appearance !== 'light' && doc.appearance !== 'dark')
    return fail('Appearance must match the base: light/dark for dual themes, constant for unified themes.')
  if (!doc.overrides || typeof doc.overrides !== 'object' || Array.isArray(doc.overrides))
    return fail('Overrides must be a token-to-color object.')
  const entries = Object.entries(doc.overrides)
  if (entries.length > THEME_TOKEN_NAMES.length) return fail('Too many token overrides.')
  const overrides: Record<string, string> = {}
  const warnings: string[] = []
  for (const [token, color] of entries) {
    // Validate even unknown entries: malicious values never get a pass.
    if (customColorChannels(color) === null)
      return fail(`Invalid color for ${token}. Use #rgb, #rrggbb, #rrggbbaa, rgb() or rgba().`)
    if (!ACTIVE_THEME_TOKENS.includes(token)) {
      warnings.push(`Ignored unknown or inactive token: ${token}`)
      continue
    }
    overrides[token] = (color as string).trim()
  }
  const coherence = validateThemeTokenOverrides(Object.keys(overrides))
  if (!coherence.ok)
    return fail('Overriding status colors requires the complete status role set (including every badge slot).')
  return {
    ok: true,
    document: {
      format: 'tau-custom-theme',
      version: 1,
      name: doc.name,
      base: base.id,
      appearance: doc.appearance as EffectiveAppearance,
      overrides,
    },
    warnings,
  }
}

/** Revalidate at the application boundary, not merely at file-open time. */
export function compileCustomTheme(raw: string, builtins: readonly ThemeDescriptor[]): Record<string, string> {
  const result = validateCustomTheme(raw, builtins)
  if (!result.ok) throw new Error(result.error)
  return Object.fromEntries(
    Object.entries(result.document.overrides).flatMap(([token, color]) => {
      const channels = customColorChannels(color)!
      const [rgb, alpha = '1'] = channels.split(' / ')
      return [
        [token, channels],
        [`--custom-rgb-${token.slice(2)}`, rgb!],
        [`--custom-alpha-${token.slice(2)}`, alpha],
      ]
    })
  )
}
