// Generates the DUAL (light+dark) primary/secondary/tertiary/neutral-palette
// built-in theme CSS blocks written into apps/web/src/theme/builtins.css,
// between the GENERATED PALETTE BUILTINS markers. Regenerate with:
// bun apps/web/scripts/generate-palette-builtins.ts
//
// Unlike generate-bigbrain-builtins.ts (which starts from a bg/fg/activity
// triple and layers BigBrain's own explicit sRGB color-mix formulas on top),
// each entry here is a genuine ThemePalette (primary/secondary/tertiary/
// neutral seeds, the same shape a user's own custom theme uses), so no
// explicit-token layer is needed:
//
// 1. Parse Tau's own `:root`/`.dark` blocks in index.css into a token->value
//    map per appearance (the derivation BASE — built-ins still involve no
//    runtime color generation; this script bakes the CSS once).
// 2. Run the shared palette derivation (`deriveThemeOverrides`, the same pure
//    engine `packages/shared/src/theme-derivation.ts` uses for custom
//    themes) against that appearance's own base tokens, restricted to the
//    same `DERIVABLE_TOKENS` set generate-bigbrain-builtins.ts uses (only the
//    `chrome` token family plus `--swatch-secondary`/`-tertiary`/
//    `--on-accent-fg` vary between built-ins; every other family — status,
//    agent-type, badge-decoration, voice-material, utility-decoration/
//    -chrome, log-terminal, ansi, brand, most of syntax/terminal/graph — is
//    copied verbatim from Tau, matching Harbor/Ember/every BigBrain-ported
//    built-in).
// 3. Run the same strict-gate contrast repair pass
//    (`repairContrastPairs`, shared with generate-bigbrain-builtins.ts)
//    separately per appearance.
//
// Status mode: `utilityParity.test.ts`'s legacy-utility-colors fixture
// freezes every built-in's `--status-ROLE-{50..950}` ramp tokens
// byte-identical to Tau's own (they share the STATUS_TOKENS family with the
// semantic fg/surface/badge slots, and `deriveThemeOverrides`'s harmonized
// mode moves every token sharing a role's `--status-ROLE-` prefix, ramp steps
// included). So even where a source preset requests `status: 'harmonized'`,
// every entry below stays `'static'` — the same choice every existing
// built-in (including the BigBrain ports) already makes — to keep that gate
// green without weakening it.
import { resolve } from 'node:path'
import { deriveThemeOverrides, type ThemePalette } from '@tau/shared/theme-derivation'
import { customColorChannels } from '@tau/shared/theme-schema'
import type { ResolvedAppearance } from '@tau/shared/theme-schema'
import { cssBlockDeclarations, DERIVABLE_TOKENS, repairContrastPairs } from './theme-builtin-shared'

export const GENERATED_START =
  '\n  /* BEGIN GENERATED PALETTE BUILTINS — apps/web/scripts/generate-palette-builtins.ts. Do not edit by hand. */\n'
export const GENERATED_END = '  /* END GENERATED PALETTE BUILTINS */\n'

export interface WebPaletteBuiltin {
  /** Theme id, matching registry.ts's BUILT_IN_THEMES entry. */
  id: string
  label: string
  /** Short intent blurb, echoed into the generated CSS comment. */
  intent: string
  palette: ThemePalette
}

/** Owner's own "Forest" preset (docs/wiki/theme/builtins.md): deep pine
 * primary, warm bark secondary, mossy tertiary, and a dark olive-gray
 * neutral tint for chrome surfaces. */
export const PALETTE_BUILTINS: readonly WebPaletteBuiltin[] = [
  {
    id: 'forest',
    label: 'Forest',
    intent: 'Owner palette preset: pine primary, bark secondary, moss tertiary, olive-gray chrome.',
    palette: {
      primary: '#3f6b4f',
      secondary: '#7a5c3e',
      tertiary: '#8a9a5b',
      neutral: '#4a4a3f',
      contrast: 'standard',
      status: 'static',
    },
  },
]

/** Builds the full compiled token map for one built-in's one appearance. */
function buildThemeTokens(palette: ThemePalette, baseTokens: Record<string, string>, appearance: ResolvedAppearance) {
  const derivedHex = deriveThemeOverrides({ baseTokens, palette, appearance })
  const combined: Record<string, string> = {}
  for (const token of Object.keys(baseTokens)) {
    if (token.startsWith('--opacity-')) {
      // Intrinsic-alpha metadata is independent of the color token's own
      // stored channels (see generate-bigbrain-builtins.ts's doc comment
      // step 6); Forest keeps Tau's own translucent values, like Harbor/Ember.
      combined[token] = baseTokens[token]!
      continue
    }
    const derived = DERIVABLE_TOKENS.has(token) ? derivedHex[token] : undefined
    combined[token] = derived ? (customColorChannels(derived) ?? baseTokens[token]!) : baseTokens[token]!
  }
  return repairContrastPairs(combined)
}

function themeCssBlock(
  builtin: WebPaletteBuiltin,
  appearance: ResolvedAppearance,
  tokens: Record<string, string>
): string {
  const selector = `  :root[data-theme='${builtin.id}'][data-appearance='${appearance}'],\n  [data-theme-scope][data-theme='${builtin.id}'][data-appearance='${appearance}'] {`
  const lines = Object.entries(tokens).map(([token, value]) => `    ${token}: ${value};`)
  return `${selector}\n    color-scheme: ${appearance};\n    /* ${builtin.label}: ${builtin.intent} See docs/wiki/theme/builtins.md. */\n${lines.join('\n')}\n  }\n`
}

export interface GeneratedPaletteTheme {
  builtin: WebPaletteBuiltin
  appearance: ResolvedAppearance
  css: string
  /** Fg tokens whose lightness the contrast repair pass moved (see
   * `repairContrastPairs`), for the docs table / generator report. */
  adjusted: string[]
}

export async function generatePaletteThemes(): Promise<GeneratedPaletteTheme[]> {
  const indexCss = await Bun.file(resolve(import.meta.dir, '../src/index.css')).text()
  const tauLight = cssBlockDeclarations(indexCss, ':root')
  const tauDark = cssBlockDeclarations(indexCss, '.dark')
  const results: GeneratedPaletteTheme[] = []
  for (const builtin of PALETTE_BUILTINS) {
    for (const [appearance, baseTokens] of [
      ['light', tauLight],
      ['dark', tauDark],
    ] as const) {
      const { tokens, adjusted } = buildThemeTokens(builtin.palette, baseTokens, appearance)
      results.push({ builtin, appearance, css: themeCssBlock(builtin, appearance, tokens), adjusted })
    }
  }
  return results
}

export async function generatePaletteBuiltinsCss(): Promise<string> {
  const themes = await generatePaletteThemes()
  return `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
}

if (import.meta.main) {
  const target = resolve(import.meta.dir, '../src/theme/builtins.css')
  const file = Bun.file(target)
  const current = await file.text()
  const themes = await generatePaletteThemes()
  const generated = `${GENERATED_START}${themes.map((t) => t.css).join('\n')}${GENERATED_END}`
  const markerRe = new RegExp(
    `${GENERATED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${GENERATED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  )
  if (markerRe.test(current)) {
    await Bun.write(target, current.replace(markerRe, generated))
  } else {
    // First run: insert right after Harbor's dark block, right before
    // Ember's light block — matches the registry's Harbor/Forest/Ember order.
    const anchor = "  :root[data-theme='ember'][data-appearance='light'],"
    const anchorIndex = current.indexOf(anchor)
    if (anchorIndex < 0) throw new Error('could not find the ember light block to insert Forest before')
    await Bun.write(target, current.slice(0, anchorIndex) + generated + current.slice(anchorIndex))
  }
  for (const theme of themes) {
    console.log(
      `${theme.builtin.id}/${theme.appearance}: ${theme.adjusted.length ? theme.adjusted.join(', ') : '(no contrast adjustments)'}`
    )
  }
}
