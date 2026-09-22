import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { type CustomThemeDocument, type AppearanceSetting } from '@tau/shared'
import { findWebTheme, resolveWebTheme } from '../theme/registry'
import { tokenColor } from '../theme/tokenReader'
import { applyResolvedTheme } from '../theme/apply'
import { getThemeStorage, persistSurfaceSnapshot } from '../theme/storage'

import { applyCustomTheme, customSelection, removeCustomProperties } from '../theme/custom'
import { ThemeSyncStore, LOCAL_OVERRIDE_KEY } from '../theme/sync'
import { CUSTOM_THEME_KEY } from '../theme/custom'
import { THEME_ID_KEY, APPEARANCE_KEY, LEGACY_THEME_KEY } from '../theme/storage'

/**
 * The resolved appearance (light/dark). Kept as `theme` for the existing
 * toggle UX and call sites; `appearance` is the user's setting, which may be
 * 'system'.
 */
type Theme = 'light' | 'dark'

interface ThemeContextValue {
  localOverride: boolean
  syncAvailable: boolean
  adoptSynced: () => void
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

const ThemeSyncContext = createContext<ThemeSyncStore | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useThemeSyncStore() {
  const store = useContext(ThemeSyncContext)
  if (!store) throw new Error('useThemeSyncStore must be used within ThemeProvider')
  return store
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
  const [store] = useState(() => new ThemeSyncStore(getThemeStorage()))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { selection, custom, error } = state
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== getThemeStorage()) return
      if (
        event.key === null ||
        [THEME_ID_KEY, APPEARANCE_KEY, LEGACY_THEME_KEY, CUSTOM_THEME_KEY, LOCAL_OVERRIDE_KEY].includes(event.key)
      )
        store.reloadFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [store])

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
        store.recoverCustom()
        return
      }
    }
    const tile = tokenColor(window.getComputedStyle(root).getPropertyValue('--brand-tile').trim())
    if (tile) document.querySelector('meta[name="msapplication-TileColor"]')?.setAttribute('content', tile)

    // Store the resolved surface color so the flash-prevention script can use
    // it before React boots. Share the pre-paint serializer: valid custom
    // alpha may compile to exponent notation, which is not a bare CSS color.
    const channels = window.getComputedStyle(root).getPropertyValue('--color-bg-surface').trim()
    const surface = tokenColor(channels)
    if (surface) {
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
  }, [resolvedThemeDefinition, resolvedAppearance, selection, custom, store])

  const setThemeId = useCallback(
    (themeId: string) => {
      store.change({ ...store.getSnapshot().selection, themeId: findWebTheme(themeId).id, customTheme: null })
    },
    [store]
  )
  const setAppearance = useCallback(
    (appearance: AppearanceSetting) => {
      store.change({ ...store.getSnapshot().selection, appearance, customTheme: null })
    },
    [store]
  )
  const setTheme = useCallback((theme: Theme) => setAppearance(theme), [setAppearance])
  const toggleTheme = useCallback(() => {
    const current = store.getSnapshot().selection
    const resolved = resolveWebTheme(current.themeId, current.appearance, systemPrefersDark)
    store.change({ ...current, appearance: resolved.appearance === 'dark' ? 'light' : 'dark', customTheme: null })
  }, [store, systemPrefersDark])
  const applyCustom = useCallback(
    (doc: CustomThemeDocument) => {
      store.change({ ...customSelection(doc, store.getSnapshot().selection), customTheme: doc })
    },
    [store]
  )
  const resetTheme = useCallback(() => {
    store.change({ themeId: 'tau', appearance: 'light', customTheme: null })
  }, [store])

  const contextValue: ThemeContextValue = {
    localOverride: state.localOverride,
    syncAvailable: state.syncAvailable,
    adoptSynced: store.adoptSynced,
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

  return (
    <ThemeSyncContext.Provider value={store}>
      <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
    </ThemeSyncContext.Provider>
  )
}
