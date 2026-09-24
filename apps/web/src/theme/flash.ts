// Source for the generated synchronous inline pre-paint script in index.html.
// Regenerate with: bun apps/web/scripts/generate-theme-flash.ts
import { applyResolvedTheme } from './apply'
import { resolveWebTheme } from './registry'
import { getThemeStorage, readSurfaceSnapshot } from './storage'
import { applyCustomTheme, clearCustomTheme, loadCustomTheme } from './custom'
import { tokenColor } from './tokenReader'

try {
  const root = document.documentElement
  const storage = getThemeStorage()
  const state = loadCustomTheme(storage)
  let dark = false
  try {
    dark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  } catch {
    /* default light */
  }
  const resolved = resolveWebTheme(state.selection.themeId, state.selection.appearance, dark)
  applyResolvedTheme(root, resolved.theme, resolved.appearance)
  if (state.custom) {
    try {
      // Palette derivation needs getComputedStyle on the built-in CSS, which is
      // not guaranteed loaded this early; skip it here (explicit overrides
      // still apply) — the next real repaint (ThemeProvider) derives fully.
      applyCustomTheme(root, state.custom, resolved.appearance, { deriveFromComputedStyle: false })
    } catch {
      clearCustomTheme(storage)
      state.custom = null
    }
  }
  // Minimal pre-CSS surface fallback; parity checked against the built-in CSS.
  const surfaces: Record<string, Partial<Record<string, string>>> = {
    tau: { light: 'rgb(255 255 255)', dark: 'rgb(16 17 28)' },
    harbor: { light: 'rgb(255 255 255)', dark: 'rgb(15 30 40)' },
    ember: { light: 'rgb(255 253 249)', dark: 'rgb(35 26 23)' },
    'high-contrast': { constant: 'rgb(255 255 255)' },
  }
  // A custom surface comes from the validated document, never a stale snapshot.
  const surface =
    (state.custom
      ? tokenColor(root.style.getPropertyValue('--color-bg-surface'))
      : readSurfaceSnapshot(storage, resolved.theme.id, resolved.appearance)) ||
    surfaces[resolved.theme.id]![resolved.appearance]!
  const tile = tokenColor(root.style.getPropertyValue('--brand-tile'))
  if (tile) document.querySelector('meta[name="msapplication-TileColor"]')?.setAttribute('content', tile)
  root.style.backgroundColor = surface
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', surface)
} catch {
  /* theme resolution must never prevent first paint */
}
