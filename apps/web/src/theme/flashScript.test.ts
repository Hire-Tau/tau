import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Window } from 'happy-dom'
import { resolveThemeSelection } from '@tau/shared'
import { installDomHarness } from '../test/domHarness'
import {
  APPEARANCE_KEY,
  LEGACY_SURFACE_COLOR_KEY,
  LEGACY_THEME_KEY,
  THEME_ID_KEY,
  THEME_SURFACE_KEY,
  type ThemeStorage,
} from './storage'
import { palettes, resolveToken } from './test/builtins'
import { BUILT_IN_THEMES } from './registry'

// Covers the inline pre-paint flash script in apps/web/index.html: the actual
// shipped script is extracted from the HTML and executed against an isolated
// DOM harness for every stored-state scenario, so what is asserted is what the
// browser runs before React boots.

const webRoot = join(import.meta.dir, '..', '..')
const html = readFileSync(join(webRoot, 'index.html'), 'utf8')

function extractFlashScript(): string {
  const match = html.match(/<script data-tau-theme-flash>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('flash script marker <script data-tau-theme-flash> not found in index.html')
  return match[1]!
}

const flashScript = extractFlashScript()

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  }
}

interface FlashScenario {
  themeId?: string | null
  appearance?: string | null
  legacyTheme?: string | null
  legacySurface?: string | null
  snapshot?: string | null
  systemPrefersDark?: boolean
  /** Pre-seeds a stale dark class, as a bfcache-restored document may carry. */
  staleDarkClass?: boolean
  /** Runs inside Tau Desktop, whose preload defines window.tauDesktopApp first. */
  desktop?: boolean
}

interface FlashResult {
  dataTheme: string | null
  dataAppearance: string | null
  hasDarkClass: boolean
  backgroundColor: string
  metaThemeColor: string | null
}

async function runFlashScript(scenario: FlashScenario): Promise<FlashResult> {
  const initial: Record<string, string> = {}
  if (scenario.themeId != null) initial[THEME_ID_KEY] = scenario.themeId
  if (scenario.appearance != null) initial[APPEARANCE_KEY] = scenario.appearance
  if (scenario.legacyTheme != null) initial[LEGACY_THEME_KEY] = scenario.legacyTheme
  if (scenario.legacySurface != null) initial[LEGACY_SURFACE_COLOR_KEY] = scenario.legacySurface
  if (scenario.snapshot != null) initial[THEME_SURFACE_KEY] = scenario.snapshot
  const storage = memoryStorage(initial)

  const dom = installDomHarness({
    url: 'http://localhost/',
    configureWindow: (window: Window) => {
      const matchMedia = (query: string) => ({
        matches: scenario.systemPrefersDark ?? false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })
      ;(window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia
      if (scenario.desktop) (window as unknown as { tauDesktopApp: { version: 1 } }).tauDesktopApp = { version: 1 }
    },
  })
  try {
    const { window } = dom
    window.document.head.innerHTML = '<meta name="theme-color" content="#ffffff" />'
    if (scenario.staleDarkClass) window.document.documentElement.classList.add('dark')

    // The shipped script is a plain IIFE over document/localStorage/window.
    const run = new Function('window', 'document', 'localStorage', flashScript)
    run(window, window.document, storage)

    const root = window.document.documentElement
    const meta = window.document.querySelector("meta[name='theme-color']")
    return {
      dataTheme: root.getAttribute('data-theme'),
      dataAppearance: root.getAttribute('data-appearance'),
      hasDarkClass: root.classList.contains('dark'),
      backgroundColor: root.style.backgroundColor,
      metaThemeColor: meta ? meta.getAttribute('content') : null,
    }
  } finally {
    await dom.cleanup()
  }
}

describe('pre-paint flash script: default appearance by host', () => {
  test('Tau Desktop with no stored choice follows the OS appearance', async () => {
    expect((await runFlashScript({ desktop: true, systemPrefersDark: true })).dataAppearance).toBe('dark')
    expect((await runFlashScript({ desktop: true, systemPrefersDark: false })).dataAppearance).toBe('light')
  })

  test('a browser with no stored choice keeps light', async () => {
    const result = await runFlashScript({ systemPrefersDark: true })
    expect(result.dataAppearance).toBe('light')
    expect(result.hasDarkClass).toBe(false)
  })

  test('a stored choice wins everywhere', async () => {
    expect((await runFlashScript({ desktop: true, systemPrefersDark: true, appearance: 'light' })).dataAppearance).toBe(
      'light'
    )
    expect((await runFlashScript({ systemPrefersDark: false, appearance: 'dark' })).dataAppearance).toBe('dark')
  })

  test("a legacy 'system' choice keeps following the OS", async () => {
    expect((await runFlashScript({ legacyTheme: 'system', systemPrefersDark: true })).dataAppearance).toBe('dark')
    expect((await runFlashScript({ legacyTheme: 'system', systemPrefersDark: false })).dataAppearance).toBe('light')
  })
})

describe('pre-paint flash script (cold load, every stored state)', () => {
  test('legacy dark: applies the dark class, attribute state, and the legacy surface snapshot', async () => {
    const result = await runFlashScript({ legacyTheme: 'dark', legacySurface: '#10111c' })
    expect(result.dataTheme).toBe('tau')
    expect(result.dataAppearance).toBe('dark')
    expect(result.hasDarkClass).toBe(true)
    expect(result.backgroundColor).toBe('#10111c')
    expect(result.metaThemeColor).toBe('#10111c')
  })

  test('legacy light: light state, no dark class', async () => {
    const result = await runFlashScript({ legacyTheme: 'light' })
    expect(result.dataTheme).toBe('tau')
    expect(result.dataAppearance).toBe('light')
    expect(result.hasDarkClass).toBe(false)
    expect(result.backgroundColor).toBe('rgb(255 255 255)')
  })

  test('new keys, dark: identical paint to the legacy dark path', async () => {
    const result = await runFlashScript({ themeId: 'tau', appearance: 'dark', legacySurface: '#10111c' })
    expect(result.dataAppearance).toBe('dark')
    expect(result.hasDarkClass).toBe(true)
    expect(result.backgroundColor).toBe('#10111c')
  })

  test('new keys, system + OS dark preference: resolves dark before paint', async () => {
    const result = await runFlashScript({ themeId: 'tau', appearance: 'system', systemPrefersDark: true })
    expect(result.dataAppearance).toBe('dark')
    expect(result.hasDarkClass).toBe(true)
  })

  test('new keys, system + OS light preference: resolves light before paint', async () => {
    const result = await runFlashScript({ themeId: 'tau', appearance: 'system', systemPrefersDark: false })
    expect(result.dataAppearance).toBe('light')
    expect(result.hasDarkClass).toBe(false)
  })

  test('no keys at all: default light surface before CSS', async () => {
    const result = await runFlashScript({})
    expect(result.dataTheme).toBe('tau')
    expect(result.dataAppearance).toBe('light')
    expect(result.hasDarkClass).toBe(false)
    expect(result.backgroundColor).toBe('rgb(255 255 255)')
  })

  test('unreadable values degrade to the default pair instead of guessing', async () => {
    for (const garbage of ['banana', 'ultraviolet', '']) {
      const result = await runFlashScript({ themeId: 'martian', appearance: garbage, legacyTheme: garbage })
      expect(result.dataTheme).toBe('tau')
      expect(result.dataAppearance).toBe('light')
      expect(result.hasDarkClass).toBe(false)
    }
  })

  test('state-keyed surface snapshot paints only for its captured state', async () => {
    const snapshot = JSON.stringify({ theme: 'tau', appearance: 'dark', surface: 'rgb(16 17 28)' })
    const matched = await runFlashScript({ themeId: 'tau', appearance: 'dark', snapshot })
    expect(matched.backgroundColor).toBe('rgb(16 17 28)')
    expect(matched.metaThemeColor).toBe('rgb(16 17 28)')

    const mismatched = await runFlashScript({ themeId: 'tau', appearance: 'light', snapshot })
    expect(mismatched.backgroundColor).toBe('rgb(255 255 255)')
  })

  test('a corrupt structured snapshot does not fall back to a possibly-stale legacy value', async () => {
    const result = await runFlashScript({
      themeId: 'tau',
      appearance: 'dark',
      snapshot: '{oops',
      legacySurface: '#10111c',
    })
    expect(result.backgroundColor).toBe('rgb(16 17 28)')
  })

  test('a stale dark class from a restored document is removed on a light cold load', async () => {
    const result = await runFlashScript({ themeId: 'tau', appearance: 'light', staleDarkClass: true })
    expect(result.hasDarkClass).toBe(false)
  })
})

describe('flash script parity with the shared resolution rules', () => {
  const cases: FlashScenario[] = [
    { themeId: 'tau', appearance: 'light', systemPrefersDark: false },
    { themeId: 'tau', appearance: 'dark', systemPrefersDark: false },
    { themeId: 'tau', appearance: 'system', systemPrefersDark: false },
    { themeId: 'tau', appearance: 'system', systemPrefersDark: true },
    { legacyTheme: 'dark' },
    { legacyTheme: 'light' },
    { themeId: 'martian', appearance: 'dark', systemPrefersDark: true },
    { legacyTheme: 'garbage' },
    {},
  ]

  test('for every scenario the painted variant equals resolveThemeSelection', async () => {
    for (const scenario of cases) {
      const shared = resolveThemeSelection(
        BUILT_IN_THEMES,
        scenario.themeId ?? null,
        (['light', 'dark', 'system'] as const).includes(scenario.appearance as 'light')
          ? (scenario.appearance as 'light' | 'dark' | 'system')
          : null,
        scenario.systemPrefersDark ?? false
      )
      const legacyFallback =
        scenario.appearance == null && (scenario.legacyTheme === 'dark' || scenario.legacyTheme === 'light')
          ? scenario.legacyTheme
          : null
      const expectedAppearance = legacyFallback ?? (shared.appearance === 'constant' ? 'light' : shared.appearance)
      const result = await runFlashScript(scenario)
      expect(result.dataTheme).toBe(shared.theme.id)
      expect(result.dataAppearance).toBe(expectedAppearance)
      expect(result.hasDarkClass).toBe(expectedAppearance === 'dark')
    }
  })
})

describe('every built-in × appearance × OS pre-paint matrix', () => {
  for (const theme of BUILT_IN_THEMES)
    for (const appearance of ['light', 'dark', 'system'] as const)
      for (const systemPrefersDark of [false, true]) {
        const resolved = resolveThemeSelection(BUILT_IN_THEMES, theme.id, appearance, systemPrefersDark).appearance
        const palette = palettes.find((p) => p.id === theme.id && p.appearance === resolved)!
        const surface = `rgb(${resolveToken(palette.tokens, '--color-bg-surface')})`
        for (const snapshot of [
          undefined,
          '{broken',
          JSON.stringify({ theme: 'unknown', appearance: resolved, surface: 'rgb(1 2 3)' }),
          JSON.stringify({ theme: theme.id, appearance: resolved, surface }),
        ]) {
          test(`${theme.id}/${appearance}/OS-dark=${systemPrefersDark}/snapshot=${snapshot}`, async () => {
            const result = await runFlashScript({
              themeId: theme.id,
              appearance,
              systemPrefersDark,
              snapshot,
              staleDarkClass: true,
            })
            expect(result.dataTheme).toBe(theme.id)
            expect(result.dataAppearance).toBe(resolved === 'constant' ? null : resolved)
            expect(result.hasDarkClass).toBe(resolved === 'dark')
            expect(result.backgroundColor).toBe(surface)
            expect(result.metaThemeColor).toBe(surface)
          })
        }
      }
})
