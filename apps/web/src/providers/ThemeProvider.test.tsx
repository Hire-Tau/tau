import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { ThemeProvider, useTheme } from './ThemeProvider'
import { acquireDomHarness } from '../test/domHarness'

// Provider-level coverage for phase 0: <html> data-theme/data-appearance
// application (keeping the .dark migration class), localStorage migration of
// the legacy 'tau-theme' key, and the live system-preference listener.

let cleanupDom: (() => Promise<void>) | null = null

function ThemeProbe({ onToggle }: { onToggle?: () => void }) {
  const { themeId, appearance, theme, toggleTheme } = useTheme()
  return (
    <div>
      <output data-testid="probe" data-theme-id={themeId} data-appearance={appearance} data-resolved={theme} />
      {onToggle ? <button data-testid="toggle" onClick={() => onToggle()} /> : null}
      <button data-testid="toggle-theme" onClick={toggleTheme} />
    </div>
  )
}

/** Installs the DOM harness with a controllable prefers-color-scheme stub. */
async function installThemeDom() {
  let systemMatches = false
  let listeners: Array<(event: { matches: boolean }) => void> = []
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow: (window) => {
      const matchMedia = (query: string): MediaQueryList =>
        ({
          media: query,
          get matches() {
            return systemMatches
          },
          addEventListener: (_type: string, listener: unknown) => {
            listeners.push(listener as (event: { matches: boolean }) => void)
          },
          removeEventListener: (_type: string, listener: unknown) => {
            listeners = listeners.filter((entry) => entry !== listener)
          },
        }) as MediaQueryList
      ;(window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia
      ;(globalThis as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia
    },
  })
  const setSystemPrefersDark = async (matches: boolean) => {
    systemMatches = matches
    await act(async () => {
      for (const listener of [...listeners]) listener({ matches })
    })
  }
  cleanupDom = () => dom.cleanup()
  return { dom, setSystemPrefersDark }
}

beforeEach(() => {
  cleanupDom = null
})

afterEach(async () => {
  await cleanupDom?.()
})

describe('ThemeProvider (themeId × appearance application)', () => {
  test('applies data-theme/data-appearance and the .dark class for a stored dark choice', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('tau-theme', 'dark')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    const rootEl = document.documentElement
    expect(rootEl.getAttribute('data-theme')).toBe('tau')
    expect(rootEl.getAttribute('data-appearance')).toBe('dark')
    expect(rootEl.classList.contains('dark')).toBe(true)

    const probe = document.querySelector('[data-testid="probe"]')!
    expect(probe.getAttribute('data-theme-id')).toBe('tau')
    expect(probe.getAttribute('data-appearance')).toBe('dark')
    expect(probe.getAttribute('data-resolved')).toBe('dark')
  })

  test('legacy tau-theme values migrate to the new keys and clear the legacy key', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('tau-theme', 'dark')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    expect(localStorage.getItem('tau-theme-id')).toBe('tau')
    expect(localStorage.getItem('tau-appearance')).toBe('dark')
    expect(localStorage.getItem('tau-theme')).toBeNull()
  })

  test('unreadable stored values fall back to the default light pair', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('tau-theme', 'mauve')
    localStorage.setItem('tau-theme-id', 'atlantis')
    localStorage.setItem('tau-appearance', 'solarized')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // The normalized selection is persisted back, repairing the storage.
    expect(localStorage.getItem('tau-theme-id')).toBe('tau')
    expect(localStorage.getItem('tau-appearance')).toBe('light')
  })

  test('toggleTheme flips the resolved appearance and the .dark class', async () => {
    const { dom } = await installThemeDom()
    const { root } = dom.createRoot()
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await act(async () => {
      ;(document.querySelector('[data-testid="toggle-theme"]') as HTMLElement).click()
    })
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('tau-appearance')).toBe('dark')

    await act(async () => {
      ;(document.querySelector('[data-testid="toggle-theme"]') as HTMLElement).click()
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('tau-appearance')).toBe('light')
  })

  test("a 'system' appearance follows live OS scheme changes without a reload", async () => {
    const { dom, setSystemPrefersDark } = await installThemeDom()
    localStorage.setItem('tau-theme-id', 'tau')
    localStorage.setItem('tau-appearance', 'system')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })
    // OS preference is light: resolved light, no dark class.
    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // The OS flips to dark while the app is open.
    await setSystemPrefersDark(true)
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const probe = document.querySelector('[data-testid="probe"]')!
    expect(probe.getAttribute('data-resolved')).toBe('dark')
    expect(probe.getAttribute('data-appearance')).toBe('system')

    // And back to light.
    await setSystemPrefersDark(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // The stored setting stays 'system' — only the resolution follows the OS.
    expect(localStorage.getItem('tau-appearance')).toBe('system')
  })
})
