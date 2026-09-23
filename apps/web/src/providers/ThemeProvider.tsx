import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { desktopBridge } from '../lib/desktop'
import {
  defaultThemePreference,
  parseThemePreference,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme'

type Theme = ResolvedTheme

interface ThemeContextValue {
  /** The theme on screen. */
  theme: Theme
  /** What the person chose (or the default): light, dark, or follow the system. */
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const SURFACE_COLOR_KEY = 'tau-surface-color'
// Which theme the stored surface color belongs to, so the pre-render script in
// index.html doesn't paint last session's surface after the OS appearance changed.
const SURFACE_THEME_KEY = 'tau-surface-theme'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode or blocked storage: the choice still applies for this visit.
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(SYSTEM_DARK_QUERY).matches
    : false
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** The theme context inside ThemeProvider, otherwise null (for components also rendered standalone). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === 'undefined') return 'light'
    return parseThemePreference(readStorage(THEME_STORAGE_KEY)) ?? defaultThemePreference(desktopBridge() !== undefined)
  })
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const theme = resolveTheme(preference, systemDark)

  // Follow OS appearance changes while the preference is "system".
  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(SYSTEM_DARK_QUERY)
    const update = () => setSystemDark(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [preference])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }

    // Store the resolved surface color so the flash-prevention script can use it
    const surface = window.getComputedStyle(root).getPropertyValue('--color-bg-surface').trim()
    if (surface) {
      writeStorage(SURFACE_COLOR_KEY, surface)
      writeStorage(SURFACE_THEME_KEY, theme)
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
  }, [theme])

  // Only an explicit choice is stored: an unset preference keeps following the
  // default (see defaultThemePreference) instead of freezing whatever it resolved to.
  const setPreference = useCallback((next: ThemePreference) => {
    writeStorage(THEME_STORAGE_KEY, next)
    setPreferenceState(next)
  }, [])
  const setTheme = useCallback((t: Theme) => setPreference(t), [setPreference])
  const toggleTheme = useCallback(() => setPreference(theme === 'dark' ? 'light' : 'dark'), [setPreference, theme])

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
