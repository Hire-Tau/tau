import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultThemePreference, parseThemePreference, resolveTheme } from './theme'

describe('theme preference', () => {
  test('only the three known values parse', () => {
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference(null)).toBeNull()
    expect(parseThemePreference('sepia')).toBeNull()
  })

  test('Tau Desktop follows the system by default; browsers keep light', () => {
    expect(defaultThemePreference(true)).toBe('system')
    expect(defaultThemePreference(false)).toBe('light')
  })

  test('system resolves from the OS appearance; explicit choices win', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

/**
 * index.html resolves the theme before React loads, so the first paint matches.
 * Run that script against stub globals and check it agrees with src/lib/theme.ts.
 */
describe('index.html pre-render theme script', () => {
  const html = readFileSync(resolve(import.meta.dir, '../../index.html'), 'utf8')
  const script = /<!-- Flash prevention script[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)![1]!

  function firstPaint({
    stored = {},
    desktop = false,
    systemDark = false,
  }: {
    stored?: Record<string, string>
    desktop?: boolean
    systemDark?: boolean
  }) {
    const classes = new Set<string>()
    const style: Record<string, string> = {}
    const window = {
      localStorage: { getItem: (key: string) => stored[key] ?? null },
      matchMedia: (query: string) => ({ matches: systemDark && query === '(prefers-color-scheme: dark)' }),
      ...(desktop ? { tauDesktopApp: { version: 1 } } : {}),
    }
    const document = {
      documentElement: { classList: { add: (name: string) => classes.add(name) }, style },
      querySelector: () => null,
    }
    new Function('window', 'document', script)(window, document)
    return { dark: classes.has('dark'), background: style.backgroundColor }
  }

  test('Tau Desktop with no stored choice follows the OS appearance', () => {
    expect(firstPaint({ desktop: true, systemDark: true }).dark).toBe(true)
    expect(firstPaint({ desktop: true, systemDark: false }).dark).toBe(false)
  })

  test('a browser with no stored choice keeps light', () => {
    expect(firstPaint({ systemDark: true }).dark).toBe(false)
  })

  test('a stored choice wins everywhere', () => {
    expect(firstPaint({ desktop: true, systemDark: true, stored: { 'tau-theme': 'light' } }).dark).toBe(false)
    expect(firstPaint({ stored: { 'tau-theme': 'dark' } }).dark).toBe(true)
    expect(firstPaint({ systemDark: true, stored: { 'tau-theme': 'system' } }).dark).toBe(true)
  })

  test("last session's surface color is reused only for the theme it was saved with", () => {
    const stored = { 'tau-surface-color': '#101010', 'tau-surface-theme': 'dark' }
    expect(firstPaint({ desktop: true, systemDark: true, stored }).background).toBe('#101010')
    expect(firstPaint({ desktop: true, systemDark: false, stored }).background).toBeUndefined()
  })
})
