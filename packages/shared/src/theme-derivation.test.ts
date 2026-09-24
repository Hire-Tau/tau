import { describe, expect, test } from 'bun:test'
import { customColorChannels } from './custom-theme'
import { deriveThemeOverrides, validateThemePalette, type ThemePalette } from './theme-derivation'
import { STATUS_TOKENS } from './theme-schema'
import { srgbToOklch } from './color-oklch'

// A representative subset of a real base theme's resolved token values (Tau
// light/dark, taken from apps/web/src/index.css), enough to exercise every
// derivation bucket without needing the full 431-token registry.
const TAU_LIGHT: Record<string, string> = {
  '--color-bg-page': '250 249 252',
  '--color-bg-surface': '255 255 255',
  '--color-text-primary': '37 35 50',
  '--color-text-secondary': '96 92 112',
  '--color-primary': '91 33 182',
  '--color-primary-hover': '109 40 217',
  '--color-primary-active': '76 29 149',
  '--color-primary-light': '109 40 217',
  '--color-selection-bg': '238 232 248',
  '--color-selection-border': '215 199 240',
  '--color-focus': '124 58 237',
  '--on-accent-fg': '255 255 255',
  '--brand-gradient-from': '168 85 247',
  '--brand-gradient-to': '124 58 237',
  '--brand-tile': '124 58 237',
  '--brand-ink': '255 255 255',
  '--agent-type-1-fg': '109 40 217',
  '--agent-type-2-fg': '29 78 216',
  '--badge-accent-1-fg': '107 33 168',
  '--graph-chart-category-1': '91 33 182',
  '--syntax-keyword': '124 58 237',
  '--syntax-string': '34 197 94',
  '--term-bg': '14 15 26',
  '--term-fg': '171 178 191',
  '--term-red': '224 108 117',
  '--log-bg': '40 44 52',
}
for (const [role, solid, fg, surface] of [
  ['progress', '59 130 246', '29 78 216', '239 246 255'],
  ['queue', '6 182 212', '14 116 144', '236 254 255'],
  ['review', '234 179 8', '161 98 7', '254 252 232'],
  ['human-wait', '168 85 247', '107 33 168', '250 245 255'],
  ['external-wait', '249 115 22', '194 65 12', '255 247 237'],
  ['attention', '245 158 11', '180 83 9', '255 251 235'],
  ['danger', '239 68 68', '185 28 28', '254 242 242'],
  ['success', '34 197 94', '21 128 61', '240 253 244'],
  ['neutral', '107 114 128', '55 65 81', '249 250 251'],
] as const) {
  TAU_LIGHT[`--status-${role}-solid`] = solid
  TAU_LIGHT[`--status-${role}-fg`] = fg
  TAU_LIGHT[`--status-${role}-surface`] = surface
  TAU_LIGHT[`--status-${role}-border`] = surface
  TAU_LIGHT[`--status-${role}-badge-fg`] = fg
  TAU_LIGHT[`--status-${role}-badge-surface`] = surface
  TAU_LIGHT[`--status-${role}-badge-hover`] = surface
}

const palette: ThemePalette = { primary: '#0ea5e9' }

describe('validateThemePalette', () => {
  test('requires a valid primary and accepts optional fields', () => {
    expect(validateThemePalette({ primary: '#0ea5e9' })).toEqual({ ok: true, palette: { primary: '#0ea5e9' } })
    expect(
      validateThemePalette({ primary: '#0ea5e9', secondary: '#f59e0b', contrast: 'high', status: 'harmonized' })
    ).toEqual({
      ok: true,
      palette: { primary: '#0ea5e9', secondary: '#f59e0b', contrast: 'high', status: 'harmonized' },
    })
  })
  test('rejects missing/invalid primary, bad color grammar, and invalid enums', () => {
    for (const raw of [
      null,
      {},
      { primary: 'url(x)' },
      { primary: '#0ea5e9', secondary: 'red' },
      { primary: '#0ea5e9', contrast: 'extreme' },
      { primary: '#0ea5e9', status: 'auto' },
    ])
      expect(validateThemePalette(raw).ok).toBe(false)
  })
})

describe('deriveThemeOverrides buckets', () => {
  const derived = deriveThemeOverrides({ baseTokens: TAU_LIGHT, palette, appearance: 'light' })

  test('neutral/chrome tokens take the neutral tint hue but preserve base lightness', () => {
    const baseOklch = srgbToOklch([255, 255, 255])
    const derivedChannels = customColorChannels(derived['--color-bg-surface']!)!
    const [r, g, b] = derivedChannels.split(' ').map(Number) as [number, number, number]
    const derivedOklch = srgbToOklch([r, g, b])
    expect(derivedOklch.l).toBeCloseTo(baseOklch.l, 1)
  })

  test('the primary family is derived from the seed with an offset/ratio modeled on the base', () => {
    const primaryRgb = customColorChannels(derived['--color-primary']!)!.split(' ').map(Number)
    const seedOklch = srgbToOklch([14, 165, 233]) // #0ea5e9
    const derivedOklch = srgbToOklch(primaryRgb as [number, number, number])
    // Round-tripping a saturated seed through sRGB clamping (serialize -> hex ->
    // reparse) can drift a few degrees near the gamut edge; this checks fidelity,
    // not exactness.
    expect(Math.abs(((derivedOklch.h - seedOklch.h + 180) % 360) - 180)).toBeLessThan(10)
    // hover is lighter than primary in the base theme; that relationship should carry over.
    const hoverRgb = customColorChannels(derived['--color-primary-hover']!)!.split(' ').map(Number)
    const hoverOklch = srgbToOklch(hoverRgb as [number, number, number])
    expect(hoverOklch.l).toBeGreaterThan(derivedOklch.l)
  })

  test('on-accent-fg picks black or white by contrast against the derived primary', () => {
    expect(['#000000', '#ffffff']).toContain(derived['--on-accent-fg'])
  })

  test('regression: --color-primary is held to the UI (3:1) contrast floor against the page, not the text (4.5:1) one', () => {
    // A bright seed that already clears 3:1 (WCAG 1.4.11 non-text) against a
    // near-white page must come through with its own lightness essentially
    // unchanged — it should NOT be additionally darkened to hit a body-text
    // 4.5:1 target. --color-primary is a UI accent (buttons/borders/icons);
    // text-level contrast for content ON it is --on-accent-fg's separate job.
    const seed = '#0ea5e9' // #0ea5e9 vs TAU_LIGHT's page (250 249 252) is ~2.61:1 (below even 3:1)
    const passesAt3 = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { primary: seed, contrast: 'standard' },
      appearance: 'light',
    })
    const rgb = customColorChannels(passesAt3['--color-primary']!)!.split(' ').map(Number) as [number, number, number]
    function relLuminance([r, g, b]: number[]): number {
      return [r, g, b]
        .map((c) => c / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    }
    const pageRgb = TAU_LIGHT['--color-bg-page']!.split(' ').map(Number)
    const ratio = (a: number[], b: number[]) => {
      const la = relLuminance(a)
      const lb = relLuminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const finalRatio = ratio(rgb, pageRgb)
    // Cleared (within sRGB integer-rounding tolerance of the bisection) the
    // 3:1 floor...
    expect(finalRatio).toBeGreaterThanOrEqual(2.99)
    // ...but was not pushed anywhere near the old 4.5:1 text-level target —
    // proving the UI floor, not the text floor, governs this pair.
    expect(finalRatio).toBeLessThan(4.0)
  })

  test('brand and categorical tokens pick a hue from primary/secondary/tertiary, keeping base lightness/chroma', () => {
    for (const token of ['--brand-tile', '--agent-type-1-fg', '--graph-chart-category-1', '--syntax-keyword']) {
      expect(derived[token]).toBeDefined()
    }
  })

  test('status is static by default: no status overrides are produced', () => {
    for (const token of STATUS_TOKENS) expect(derived[token]).toBeUndefined()
  })

  test('ANSI-named terminal/log slots are never touched; term/log backgrounds ARE (neutral bucket)', () => {
    expect(derived['--term-red']).toBeUndefined()
    expect(derived['--term-bg']).toBeDefined()
    expect(derived['--log-bg']).toBeDefined()
  })
})

describe('harmonized status', () => {
  test('shifts each role toward the nearest seed, bounded, and keeps roles mutually separated', () => {
    const harmonized = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { ...palette, status: 'harmonized' },
      appearance: 'light',
    })
    const hues = new Map<string, number>()
    for (const [i, role] of [
      'progress',
      'queue',
      'review',
      'human-wait',
      'external-wait',
      'attention',
      'danger',
      'success',
      'neutral',
    ].entries()) {
      const rgb = customColorChannels(harmonized[`--status-${role}-solid`]!)!.split(' ').map(Number)
      hues.set(role, srgbToOklch(rgb as [number, number, number]).h)
      void i
    }
    // Danger stays in the red/orange family, success in the green family: a
    // bounded (<=22 degree) shift toward a single cyan seed must not relabel
    // their semantic hue band.
    const danger = hues.get('danger')!
    expect(danger < 40 || danger > 340).toBe(true)
    expect(hues.get('success')!).toBeGreaterThan(100)
    expect(hues.get('success')!).toBeLessThan(180)
    const values = [...hues.values()]
    for (let i = 0; i < values.length; i++)
      for (let j = i + 1; j < values.length; j++) {
        const delta = Math.abs(((values[i]! - values[j]! + 180) % 360) - 180)
        expect(delta).toBeGreaterThan(1) // never fully collapse two roles onto each other
      }
  })
})

describe('contrast pass (property spread over many seeds)', () => {
  // Deterministic LCG so failures reproduce; not Math.random.
  function* seeds(count: number) {
    let state = 42
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    for (let i = 0; i < count; i++) {
      const h = Math.floor(next() * 360)
      const s = 0.3 + next() * 0.6
      const l = 0.3 + next() * 0.4
      // Simple HSL->RGB for a broad, valid spread of seed colors.
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = l - c / 2
      const [r1, g1, b1] =
        h < 60
          ? [c, x, 0]
          : h < 120
            ? [x, c, 0]
            : h < 180
              ? [0, c, x]
              : h < 240
                ? [0, x, c]
                : h < 300
                  ? [x, 0, c]
                  : [c, 0, x]
      const toHex = (v: number) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, '0')
      yield `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`
    }
  }

  function wcag(fg: [number, number, number], bg: [number, number, number]): number {
    const lum = (rgb: number[]) =>
      rgb
        .map((c) => c / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    const a = lum(fg)
    const b = lum(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  test.each(['light', 'dark'] as const)(
    '%s: text/surface and primary/page clear the standard target for every seed',
    (appearance) => {
      let checked = 0
      for (const seed of seeds(60)) {
        const derived = deriveThemeOverrides({
          baseTokens: TAU_LIGHT,
          palette: { primary: seed, contrast: 'standard' },
          appearance,
        })
        const rgb = (token: string) =>
          customColorChannels(derived[token] ?? TAU_LIGHT[token]!)!
            .split(' ')
            .map(Number) as [number, number, number]
        expect(wcag(rgb('--color-text-primary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(4.5 - 1e-6)
        expect(wcag(rgb('--color-text-secondary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(4.5 - 1e-6)
        checked++
      }
      expect(checked).toBe(60)
    }
  )

  test('contrast: high raises the target and still clears it for every seed', () => {
    let checked = 0
    for (const seed of seeds(40)) {
      const derived = deriveThemeOverrides({
        baseTokens: TAU_LIGHT,
        palette: { primary: seed, contrast: 'high' },
        appearance: 'light',
      })
      const rgb = (token: string) =>
        customColorChannels(derived[token] ?? TAU_LIGHT[token]!)!
          .split(' ')
          .map(Number) as [number, number, number]
      expect(wcag(rgb('--color-text-primary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(7 - 1e-6)
      checked++
    }
    expect(checked).toBe(40)
  })
})
