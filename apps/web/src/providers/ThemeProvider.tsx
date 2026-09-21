import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import type { AppearanceSetting } from '@tau/shared'
import { findWebTheme, resolveWebTheme } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { getThemeStorage, persistSurfaceSnapshot, persistThemeSelection, readThemeSelection } from '../theme/storage'

/**
 * The resolved appearance (light/dark). Kept as `theme` for the existing
 * toggle UX and call sites; `appearance` is the user's setting, which may be
 * 'system'.
 */
type Theme = 'light' | 'dark'

interface ThemeContextValue {
  /** The registered theme id currently applied (e.g. 'tau'). */
  themeId: string
  /** The user's appearance setting: 'light' | 'dark' | 'system'. */
  appearance: AppearanceSetting
  /** The resolved appearance after 'system' is resolved against the OS. */
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  setThemeId: (themeId: string) => void
  setAppearance: (appearance: AppearanceSetting) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** Reads the OS color-scheme preference once; light when unavailable. */
function readSystemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The stored selection is read once, synchronously: legacy 'tau-theme'
  // values migrate here, unreadable values fall back to the defaults.
  const [selection, setSelection] = useState(() => readThemeSelection(getThemeStorage()))
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark)

  // Live system-preference tracking: a 'system' appearance follows OS scheme
  // changes without a reload (new capability in phase 0).
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    } catch {
      return
    }
  }, [])

  const resolved = resolveWebTheme(selection.themeId, selection.appearance, systemPrefersDark)
  const { theme: resolvedThemeDefinition, appearance: resolvedAppearance } = resolved
  const resolvedTheme: Theme = resolvedAppearance === 'dark' ? 'dark' : 'light'

  useLayoutEffect(() => {
    const root = document.documentElement
    applyResolvedTheme(root, resolvedThemeDefinition, resolvedAppearance)
    persistThemeSelection(getThemeStorage(), selection)

    // Store the resolved surface color so the flash-prevention script can use
    // it before React boots; token values are channel triplets, so wrap them
    // into a real CSS color.
    const channels = window.getComputedStyle(root).getPropertyValue('--color-bg-surface').trim()
    if (channels) {
      const surface = /^[\d\s./%]+$/.test(channels) ? `rgb(${channels})` : channels
      persistSurfaceSnapshot(getThemeStorage(), resolvedThemeDefinition.id, resolvedAppearance, surface)
      root.style.backgroundColor = surface

      // Keep the theme-color meta in sync: Safari/iOS tints its chrome (tab
      // bar, PWA status glass) with it, so it must match the header surface.
      let meta = document.querySelector<HTMLMetaElement>("meta[name='theme-color']")
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      meta.content = surface
    }
  }, [resolvedThemeDefinition, resolvedAppearance, selection])

  const setThemeId = useCallback(
    (themeId: string) => setSelection((s) => ({ ...s, themeId: findWebTheme(themeId).id })),
    []
  )
  const setAppearance = useCallback((appearance: AppearanceSetting) => setSelection((s) => ({ ...s, appearance })), [])
  const setTheme = useCallback((theme: Theme) => setAppearance(theme), [setAppearance])
  const toggleTheme = useCallback(() => {
    setSelection((s) => {
      const current = resolveWebTheme(s.themeId, s.appearance, systemPrefersDark)
      const next: Theme = current.appearance === 'dark' ? 'light' : 'dark'
      return { ...s, appearance: next }
    })
  }, [systemPrefersDark])

  const contextValue: ThemeContextValue = {
    themeId: resolvedThemeDefinition.id,
    appearance: selection.appearance,
    theme: resolvedTheme,
    toggleTheme,
    setTheme,
    setAppearance,
    setThemeId,
  }

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
}
