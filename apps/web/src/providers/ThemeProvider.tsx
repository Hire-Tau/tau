import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import { validateCustomTheme, type CustomThemeDocument, type AppearanceSetting } from '@tau/shared'
import { BUILT_IN_THEMES, findWebTheme, resolveWebTheme } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { getThemeStorage, persistSurfaceSnapshot, persistThemeSelection } from '../theme/storage'

import {
  applyCustomTheme,
  clearCustomTheme,
  customSelection,
  loadCustomTheme,
  persistCustomTheme,
  removeCustomProperties,
} from '../theme/custom'

/**
 * The resolved appearance (light/dark). Kept as `theme` for the existing
 * toggle UX and call sites; `appearance` is the user's setting, which may be
 * 'system'.
 */
type Theme = 'light' | 'dark'

interface ThemeContextValue {
  /** The registered theme id currently applied (e.g. 'tau'). */
  customTheme: CustomThemeDocument | null
  customThemeError: string | null
  applyCustom: (doc: CustomThemeDocument) => void
  resetTheme: () => void
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
  const [state, setState] = useState(() => loadCustomTheme(getThemeStorage()))
  const { selection, custom, error } = state
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
    removeCustomProperties(root)
    applyResolvedTheme(root, resolvedThemeDefinition, resolvedAppearance)
    if (custom) {
      try {
        applyCustomTheme(root, custom)
      } catch {
        clearCustomTheme(getThemeStorage())
        setState((s) => ({ ...s, custom: null, error: 'Custom theme could not be applied. Restored its base theme.' }))
        return
      }
    }
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
  }, [resolvedThemeDefinition, resolvedAppearance, selection, custom])

  const setThemeId = useCallback((themeId: string) => {
    clearCustomTheme(getThemeStorage())
    setState((s) => ({ selection: { ...s.selection, themeId: findWebTheme(themeId).id }, custom: null, error: null }))
  }, [])
  const setAppearance = useCallback((appearance: AppearanceSetting) => {
    clearCustomTheme(getThemeStorage())
    setState((s) => ({ selection: { ...s.selection, appearance }, custom: null, error: null }))
  }, [])
  const setTheme = useCallback((theme: Theme) => setAppearance(theme), [setAppearance])
  const toggleTheme = useCallback(() => {
    clearCustomTheme(getThemeStorage())
    setState((s) => {
      const current = resolveWebTheme(s.selection.themeId, s.selection.appearance, systemPrefersDark)
      const next: Theme = current.appearance === 'dark' ? 'light' : 'dark'
      return { selection: { ...s.selection, appearance: next }, custom: null, error: null }
    })
  }, [systemPrefersDark])
  const applyCustom = useCallback((doc: CustomThemeDocument) => {
    const result = validateCustomTheme(JSON.stringify(doc), BUILT_IN_THEMES)
    if (!result.ok) throw new Error(result.error)
    const saved = persistCustomTheme(getThemeStorage(), result.document)
    setState((s) => ({
      selection: customSelection(result.document, s.selection),
      custom: result.document,
      error: saved ? null : 'Theme applied for this session only: device storage is unavailable.',
    }))
  }, [])
  const resetTheme = useCallback(() => {
    clearCustomTheme(getThemeStorage())
    setState({ selection: { themeId: 'tau', appearance: 'light' }, custom: null, error: null })
  }, [])

  const contextValue: ThemeContextValue = {
    customTheme: custom,
    customThemeError: error,
    applyCustom,
    resetTheme,
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
