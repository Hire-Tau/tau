import { afterEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
import type { CustomThemeDocument } from '@tau/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ThemeProvider, useTheme, useThemeSyncStore } from '../providers/ThemeProvider'
import type { ThemeSyncStore } from '../theme/sync'
import { ThemeQuickPicker } from './ThemeQuickPicker'
import { palettes, resolveToken } from '../theme/test/builtins'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const customDoc: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 1,
  name: 'Midnight',
  base: 'harbor',
  appearance: 'dark',
  overrides: { '--color-primary': '#0ea5e9' },
}

function Harness({ enabled = true, storeRef }: { enabled?: boolean; storeRef?: { current: ThemeSyncStore | null } }) {
  const value = useTheme()
  const store = useThemeSyncStore()
  if (storeRef) storeRef.current = store
  return <ThemeQuickPicker value={value} enabled={enabled} />
}

async function renderPicker({
  enabled = true,
  custom,
  themeId,
  appearance,
  dark = false,
}: {
  enabled?: boolean
  custom?: CustomThemeDocument
  themeId?: string
  appearance?: string
  dark?: boolean
} = {}) {
  const dom = await acquireDomHarness({
    url: 'https://tau.test',
    configureWindow: (window) => {
      window.matchMedia = (() => ({
        matches: dark,
        addEventListener() {},
        removeEventListener() {},
      })) as typeof window.matchMedia
    },
  })
  cleanup = () => dom.cleanup()
  if (themeId) localStorage.setItem('tau-theme-id', themeId)
  if (appearance) localStorage.setItem('tau-appearance', appearance)
  if (custom) localStorage.setItem('tau-custom-theme', JSON.stringify(custom))
  // Real per-theme cascade: mirrors the shipped selectors (:root and
  // [data-theme-scope]) so the circle swatches resolve genuine tokens, not a
  // synthetic stand-in.
  const sheet = document.createElement('style')
  sheet.textContent = palettes
    .map((p) => {
      const attrs = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
      return `:root${attrs}, [data-theme-scope]${attrs} { ${Object.entries(p.tokens)
        .map(([key]) => `${key}: ${resolveToken(p.tokens, key)};`)
        .join(' ')} }`
    })
    .join('\n')
  document.head.append(sheet)
  const storeRef: { current: ThemeSyncStore | null } = { current: null }
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Harness enabled={enabled} storeRef={storeRef} />
      </ThemeProvider>
    )
  )
  return { dom, container, storeRef: storeRef as { current: ThemeSyncStore } }
}

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[title="Theme"]')!
}

async function open(container: HTMLElement) {
  await act(async () => fireEvent.click(trigger(container)))
}

// React's onMouseEnter/onMouseLeave are synthesized from native
// mouseover/mouseout (enter/leave do not reliably bubble to the delegated
// root listener), so tests dispatch those, matching EntityReferenceLink's
// hover fixture.
function hoverEnter(element: Element) {
  return act(async () => element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
}
function hoverLeave(element: Element) {
  return act(async () => element.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })))
}

test('hides the trigger entirely when disabled, without touching the DOM otherwise', async () => {
  const { container } = await renderPicker({ enabled: false })
  expect(trigger(container)).toBeNull()
  expect(container.querySelector('button')).toBeNull()
})

test('trigger exposes aria-haspopup/aria-expanded and opens a labelled dialog', async () => {
  const { container } = await renderPicker()
  const button = trigger(container)
  expect(button.getAttribute('aria-haspopup')).toBe('dialog')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  await open(container)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const dialog = getByRole(container, 'dialog', { name: 'Theme' })
  expect(dialog).not.toBeNull()
})

test('lists all four built-ins with the stored theme checked, none other', async () => {
  const { container } = await renderPicker({ themeId: 'harbor' })
  await open(container)
  const circles = getAllByRole(container, 'radio', { name: /Tau|Harbor|Ember|High contrast/ })
  expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual(['Tau', 'Harbor', 'Ember', 'High contrast'])
  expect(circles.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
  circles.forEach((c) => expect(c.getAttribute('role')).toBe('radio'))
})

test('adds the active custom theme circle, selected instead of its base built-in', async () => {
  const { container } = await renderPicker({ custom: customDoc })
  await open(container)
  const circles = getAllByRole(container, 'radio', { name: /Tau|Harbor|Ember|High contrast|Midnight/ })
  expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual([
    'Tau',
    'Harbor',
    'Ember',
    'High contrast',
    'Midnight',
  ])
  const harborCircle = getByRole(container, 'radio', { name: 'Harbor' })
  const customCircle = getByRole(container, 'radio', { name: 'Midnight' })
  expect(harborCircle.getAttribute('aria-checked')).toBe('false')
  expect(customCircle.getAttribute('aria-checked')).toBe('true')
})

test('custom circle swatch resolves the compiled override, not the plain harbor token', async () => {
  const { container } = await renderPicker({ custom: customDoc })
  await open(container)
  const customCircle = getByRole(container, 'radio', { name: 'Midnight' })
  const swatch = customCircle.querySelector('[data-theme-scope]')!
  const style = window.getComputedStyle(swatch)
  // The custom document overrides --color-primary to #0ea5e9 = rgb(14 165 233).
  expect(style.getPropertyValue('--color-primary').trim()).toBe('14 165 233')
  expect(swatch.getAttribute('data-theme')).toBe('harbor')
  expect(swatch.getAttribute('data-appearance')).toBe('dark')
})

test('each built-in circle resolves its own real --color-primary token under the current appearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const values = new Map<string, string>()
  for (const label of ['Tau', 'Harbor', 'Ember', 'High contrast']) {
    const circle = getByRole(container, 'radio', { name: label })
    const swatch = circle.querySelector('[data-theme-scope]')!
    values.set(label, window.getComputedStyle(swatch).getPropertyValue('--color-primary').trim())
  }
  // Every theme's swatch resolves a distinct, non-empty accent token.
  expect(values.get('Tau')).toBe('91 33 182')
  expect(values.get('Harbor')).toBe('14 95 109')
  expect(values.get('Ember')).toBe('151 55 29')
  expect(values.get('High contrast')).toBe('0 0 0')
  expect(new Set(values.values()).size).toBe(4)
})

test('clicking a circle swaps the palette only, preserving the stored appearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'dark' })
  await open(container)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Ember' })))
  expect(localStorage.getItem('tau-theme-id')).toBe('ember')
  expect(localStorage.getItem('tau-appearance')).toBe('dark')
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
})

test('Enter and Space activate a circle exactly like a click', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const harbor = getByRole(container, 'radio', { name: 'Harbor' })
  await act(async () => fireEvent.keyDown(harbor, { key: 'Enter' }))
  expect(localStorage.getItem('tau-theme-id')).toBe('harbor')
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Tau' })))
  expect(localStorage.getItem('tau-theme-id')).toBe('tau')
  await act(async () => fireEvent.keyDown(getByRole(container, 'radio', { name: 'Ember' }), { key: ' ' }))
  expect(localStorage.getItem('tau-theme-id')).toBe('ember')
})

test('appearance toggle applies light/dark/system and stays wired to the existing setAppearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Dark' })))
  expect(localStorage.getItem('tau-appearance')).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'System' })))
  expect(localStorage.getItem('tau-appearance')).toBe('system')
})

test('appearance is disabled for a unified theme, with the same explanatory hint as Settings', async () => {
  const { container } = await renderPicker({ themeId: 'high-contrast' })
  await open(container)
  const light = getByRole(container, 'radio', { name: 'Light' })
  const dark = getByRole(container, 'radio', { name: 'Dark' })
  const system = getByRole(container, 'radio', { name: 'System' })
  expect(light.hasAttribute('disabled')).toBe(true)
  expect(dark.hasAttribute('disabled')).toBe(true)
  expect(system.hasAttribute('disabled')).toBe(true)
  expect(container.textContent).toContain('High contrast has one appearance.')
})

test('surfaces the same account-sync/device-override notice the Settings picker shows', async () => {
  const { container, storeRef } = await renderPicker()
  await act(async () => {
    storeRef.current.connect({
      getMine: async () => ({ userId: 'u1', theme: { themeId: 'tau', appearance: 'light', customTheme: null } }),
      updateMine: async (input) => ({ userId: 'u1', theme: input.theme }),
    })
    await storeRef.current.refresh()
  })
  await open(container)
  expect(container.textContent).toContain('Following your account theme.')
})

// --- Hover preview -----------------------------------------------------

/** Owns just the hover-intent deadline (100ms); everything else keeps the real clock. */
function useHoverTimer() {
  const deadlines = new Map<number, { callback: () => void; ms: number }>()
  let serial = 10000
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === 100) {
      deadlines.set(++serial, { callback, ms })
      return serial
    }
    return originalSet(callback, ms, ...(rest as []))
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    if (!deadlines.delete(Number(id))) originalClear(id)
  }) as typeof clearTimeout)
  return {
    advance: (ms: number) =>
      act(async () => {
        for (const [id, deadline] of [...deadlines])
          if (deadline.ms <= ms) {
            deadlines.delete(id)
            deadline.callback()
          }
      }),
    pending: () => deadlines.size,
    restore: () => {
      timer.mockRestore()
      clear.mockRestore()
    },
  }
}

test('hovering a circle previews the whole app after the intent delay, pure DOM only', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const ember = getByRole(container, 'radio', { name: 'Ember' })
    await hoverEnter(ember)
    // Not yet: the debounce has not elapsed.
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    // Zero persistence during preview.
    expect(localStorage.getItem('tau-theme-id')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('sweeping quickly across circles cancels the pending preview (no strobe)', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    const ember = getByRole(container, 'radio', { name: 'Ember' })
    await hoverEnter(harbor)
    await hoverLeave(harbor)
    await hoverEnter(ember)
    expect(hover.pending()).toBe(1)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    expect(localStorage.getItem('tau-theme-id')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('leaving a circle after the preview committed fully restores the stored selection', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  const setItem = spyOn(window.localStorage, 'setItem')
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await hoverLeave(harbor)
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    // No store/localStorage write happened anywhere in the preview+restore cycle.
    expect(setItem).not.toHaveBeenCalled()
  } finally {
    setItem.mockRestore()
    hover.restore()
  }
})

test('keyboard focus never triggers the live preview', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await act(async () => harbor.focus())
    await hover.advance(1000)
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('Escape closes the flyout, restores any live preview, and returns focus to the trigger', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await act(async () => fireEvent.keyDown(document, { key: 'Escape', bubbles: true }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(queryByRole(container, 'dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger(container))
  } finally {
    hover.restore()
  }
})

test('restore re-reads the store at leave time, reflecting a selection changed during preview', async () => {
  const { container, storeRef } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    // Selection changes elsewhere (e.g. Settings, another tab) while hovering.
    await act(async () => storeRef.current.change({ themeId: 'ember', appearance: 'light', customTheme: null }))
    await hoverLeave(harbor)
    // Restores to the NEW stored selection, not the pre-hover one.
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  } finally {
    hover.restore()
  }
})

test('click-outside closes the flyout and restores any live preview', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })))
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(queryByRole(container, 'dialog')).toBeNull()
  } finally {
    hover.restore()
  }
})
