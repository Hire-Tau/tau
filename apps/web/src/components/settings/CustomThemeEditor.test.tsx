import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { act, useState } from 'react'
import { fireEvent, getByLabelText, getByRole, getAllByRole, queryByRole } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponseError } from '@tau/client-core'
import { STATUS_TOKENS, type ThemePreset } from '@tau/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme, useThemeSyncStore } from '../../providers/ThemeProvider'
import { CustomThemeEditor } from './CustomThemeEditor'
import { palettes, resolveToken } from '../../theme/test/builtins'
import { client } from '../../api/clientInstance'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const existing: ThemePreset = {
  id: 'preset-1',
  document: {
    format: 'tau-custom-theme',
    version: 2,
    name: 'Mine',
    base: 'harbor',
    variants: { light: {}, dark: { '--color-text-primary': '#ffffff', '--color-bg-surface': '#ffffff' } },
  },
  visibility: 'private',
  ownerUserId: 'u1',
  owner: { id: 'u1', displayName: 'Owner' },
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function Harness({
  preset,
  baseId,
  onClose,
  onReady,
}: {
  preset: ThemePreset | null
  baseId: string
  onClose: () => void
  onReady?: (value: ReturnType<typeof useTheme>, store: ReturnType<typeof useThemeSyncStore>) => void
}) {
  const value = useTheme()
  const store = useThemeSyncStore()
  onReady?.(value, store)
  return <CustomThemeEditor value={value} preset={preset} baseId={baseId} onClose={onClose} />
}

async function render({
  preset = null as ThemePreset | null,
  baseId = 'harbor',
  appearance = 'dark',
  onReady = undefined as
    | ((value: ReturnType<typeof useTheme>, store: ReturnType<typeof useThemeSyncStore>) => void)
    | undefined,
} = {}) {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  localStorage.setItem('tau-appearance', appearance)
  if (preset) {
    // The preset being edited is also the ACTIVE applied theme, so "restore
    // on close" has something non-trivial (the preset's own unedited state)
    // to restore to, distinct from the in-editor draft.
    localStorage.setItem('tau-theme-id', preset.document.base)
    localStorage.setItem('tau-custom-theme', JSON.stringify(preset.document))
    localStorage.setItem('tau-theme-preset-id', preset.id)
  }
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = mock(() => {})
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness preset={preset} baseId={baseId} onClose={onClose} onReady={onReady} />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  return { container, onClose, queryClient }
}
async function click(container: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(getByRole(container, 'button', { name, exact: true }))
  })
}
async function change(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    fireEvent.change(getByLabelText(container, label), { target: { value } })
  })
}

test('a new theme editor previews the whole app live; Save as new creates a preset and applies it', async () => {
  const create = spyOn(client.themePresets, 'create').mockResolvedValue({
    ...existing,
    id: 'new-preset',
    document: { ...existing.document, name: 'My theme' },
  })
  try {
    const { container, onClose } = await render({ baseId: 'harbor', appearance: 'dark' })
    const before = document.documentElement.style.getPropertyValue('--color-text-primary')
    await change(container, 'Color token', '--color-text-primary')
    await change(container, 'Color value', '#00ff00')
    await click(container, 'Preview token')
    // Whole-app live preview: document.documentElement itself reflects the draft.
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).not.toBe(before)
    await click(container, 'Save as new')
    expect(create).toHaveBeenCalledTimes(1)
    const [sentDocument] = create.mock.calls[0]!
    expect((sentDocument as { variants: { dark: Record<string, string> } }).variants.dark['--color-text-primary']).toBe(
      '#00ff00'
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('tau-theme-preset-id')).toBe('new-preset')
  } finally {
    create.mockRestore()
  }
})

test('editing an existing preset: Save sends a PUT with its revision', async () => {
  const update = spyOn(client.themePresets, 'update').mockResolvedValue({ ...existing, revision: 4 })
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    await click(container, 'Save')
    expect(update).toHaveBeenCalledWith('preset-1', 3, expect.anything())
    expect(onClose).toHaveBeenCalledTimes(1)
  } finally {
    update.mockRestore()
  }
})

test('a stale-revision 409 surfaces a clear reload message and does not close the editor', async () => {
  const update = spyOn(client.themePresets, 'update').mockRejectedValue(
    new HttpResponseError(409, 'Theme preset changed elsewhere — reload it before saving')
  )
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    await click(container, 'Save')
    expect(getByRole(container, 'status').textContent).toContain('changed elsewhere')
    expect(onClose).not.toHaveBeenCalled()
  } finally {
    update.mockRestore()
  }
})

test('Cancel closes without touching the network; the caller unmounting the editor is what restores the saved selection (see next test)', async () => {
  const create = spyOn(client.themePresets, 'create')
  const update = spyOn(client.themePresets, 'update')
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
    await change(container, 'Color token', '--color-text-primary')
    await change(container, 'Color value', '#00ff00')
    await click(container, 'Preview token')
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
    await click(container, 'Cancel')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  } finally {
    create.mockRestore()
    update.mockRestore()
  }
})

test('unmounting the editor (not just Cancel) also restores the saved selection', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  localStorage.setItem('tau-appearance', 'dark')
  localStorage.setItem('tau-theme-id', existing.document.base)
  localStorage.setItem('tau-custom-theme', JSON.stringify(existing.document))
  localStorage.setItem('tau-theme-preset-id', existing.id)
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { root, container } = dom.createRoot()
  function Toggle() {
    const value = useTheme()
    const [open, setOpen] = useState(true)
    return (
      <div>
        {open && <CustomThemeEditor value={value} preset={existing} baseId="harbor" onClose={() => setOpen(false)} />}
        <button data-testid="force-close" onClick={() => setOpen(false)} />
      </div>
    )
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Toggle />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
  await act(async () => fireEvent.click(container.querySelector('[data-testid="force-close"]')!))
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
})

async function selectTab(container: HTMLElement, name: 'Light' | 'Dark') {
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name })))
}

test('dual bases expose Light/Dark tabs that preview and edit independently', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  expect(getByRole(container, 'radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
  await selectTab(container, 'Light')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('')
  await change(container, 'Color token', '--color-primary')
  await change(container, 'Color value', '#123456')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('18 52 86')
  // The dark side is untouched by the light-side edit.
  await selectTab(container, 'Dark')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
})

test('a unified base has no variant tabs', async () => {
  const { container } = await render({ baseId: 'high-contrast' })
  expect(queryByRole(container, 'radio', { name: 'Light' })).toBeNull()
  expect(queryByRole(container, 'radio', { name: 'Dark' })).toBeNull()
})

test('status picker authors the complete grid as a set, and removing one clears the whole set', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  await change(container, 'Color token', '--status-danger-fg')
  await click(container, 'Preview token')
  for (const token of STATUS_TOKENS) expect(document.documentElement.style.getPropertyValue(token)).not.toBe('')
  await click(container, 'Remove --status-danger-fg')
  for (const token of STATUS_TOKENS) expect(document.documentElement.style.getPropertyValue(token)).toBe('')
})

test('contrast warnings offer a safe value that improves the pair and clears the warning', async () => {
  const { container } = await render({ baseId: 'tau', appearance: 'light' })
  // A near-invisible pair: white text on a near-white surface.
  await change(container, 'Color token', '--color-bg-surface')
  await change(container, 'Color value', '#ffffff')
  await click(container, 'Preview token')
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#ffffff')
  await click(container, 'Preview token')
  const warning = getAllByRole(container, 'listitem').find((li) =>
    li.textContent?.startsWith('--color-text-primary on --color-bg-surface')
  )
  expect(warning).toBeDefined()
  await act(async () => fireEvent.click(getByRole(warning!, 'button')))
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 0 0')
  const stillWarning = getAllByRole(container, 'listitem').find((li) =>
    li.textContent?.startsWith('--color-text-primary on --color-bg-surface')
  )
  expect(stillWarning).toBeUndefined()
})

test('no Import JSON control in the editor: Import lives once, in the library (see ThemePresetLibrary.test.tsx)', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  expect(queryByRole(container, 'button', { name: /Import/ })).toBeNull()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})

test('a primary seed color derives the palette live; clearing it returns to plain overrides; Advanced holds the token list', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'light' })
  expect(queryByRole(container, 'textbox', { name: 'Primary' })).not.toBeNull()
  // The token list/tabs/contrast warnings are tucked under a collapsed Advanced section.
  expect(container.querySelector('details')).not.toBeNull()
  expect(container.querySelector('details')!.hasAttribute('open')).toBe(false)

  const before = document.documentElement.style.getPropertyValue('--color-primary-hover')
  await change(container, 'Primary', '#0ea5e9')
  const derivedHover = document.documentElement.style.getPropertyValue('--color-primary-hover')
  expect(derivedHover).not.toBe('')
  expect(derivedHover).not.toBe(before)
  // Status stays static by default: unaffected by the palette.
  const baseStatus = document.documentElement.style.getPropertyValue('--status-danger-solid')
  expect(baseStatus).toBe('')

  await change(container, 'Primary', '')
  expect(document.documentElement.style.getPropertyValue('--color-primary-hover')).toBe('')
})

test('the Status colors toggle switches between static (default) and harmonized', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'light' })
  await change(container, 'Primary', '#0ea5e9')
  expect(document.documentElement.style.getPropertyValue('--status-danger-solid')).toBe('')
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Harmonized' })))
  expect(document.documentElement.style.getPropertyValue('--status-danger-solid')).not.toBe('')
})

test('palette seed fields are color controls: a native color swatch plus the hex/text field, with accessible labels', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  const primarySwatch = container.querySelector('input[type="color"][aria-label="Primary color swatch"]')
  const primaryText = getByRole(container, 'textbox', { name: 'Primary' })
  expect(primarySwatch).not.toBeNull()
  expect(primaryText).not.toBeNull()
  // Optional seeds start with no clear button (nothing set).
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).toBeNull()

  // Driving the native color input updates the same palette state as the text field.
  await act(async () => fireEvent.input(primarySwatch!, { target: { value: '#ff4fa3' } }))
  expect((primaryText as HTMLInputElement).value).toBe('#ff4fa3')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('255 79 163')

  // Setting an optional seed shows its Clear button; clearing empties it and re-derives without it.
  await change(container, 'Secondary', '#22c55e')
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).not.toBeNull()
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Clear Secondary' })))
  expect((getByRole(container, 'textbox', { name: 'Secondary' }) as HTMLInputElement).value).toBe('')
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).toBeNull()
})

function toHex(channels: string): string {
  const [r, g, b] = channels.trim().split(/\s+/).map(Number)
  const hex = (n: number) => Math.round(n!).toString(16).padStart(2, '0')
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`
}

test("an unset seed swatch reflects the active base theme's own --color-border token, not a hardcoded color", async () => {
  // Two different base themes -> two different --color-border values -> the
  // "not set yet" placeholder swatch must differ too. A hardcoded literal
  // (any fixed hex, however it's obfuscated in source) would be identical
  // across both and fail this.
  const harbor = await render({ baseId: 'harbor', appearance: 'dark' })
  await change(harbor.container, 'Primary', '#0ea5e9') // reveals the Secondary field (requires a palette)
  const harborSwatch = getByLabelText(harbor.container, 'Secondary color swatch') as HTMLInputElement
  const computedBorder = () =>
    toHex(
      document.documentElement.ownerDocument
        .defaultView!.getComputedStyle(document.documentElement)
        .getPropertyValue('--color-border')
        .trim()
    )
  const harborBorder = computedBorder()
  expect(harborSwatch.value).toBe(harborBorder)
  await cleanup?.()

  const ember = await render({ baseId: 'ember', appearance: 'dark' })
  await change(ember.container, 'Primary', '#0ea5e9')
  const emberSwatch = getByLabelText(ember.container, 'Secondary color swatch') as HTMLInputElement
  const emberBorder = computedBorder()
  expect(emberSwatch.value).toBe(emberBorder)

  expect(emberBorder).not.toBe(harborBorder)
  expect(emberSwatch.value).not.toBe(harborSwatch.value)
})

test('the editor draft preview survives an appearance change made elsewhere while editing', async () => {
  let value: ReturnType<typeof useTheme> | undefined
  const { container } = await render({
    preset: existing,
    appearance: 'dark',
    onReady: (v) => {
      value = v
    },
  })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // A real ThemeProvider repaint triggered by something OTHER than the editor
  // (here: the app's own Light/Dark/System control) must not clobber the
  // still-open draft preview: the provider reapplies the active preview
  // painter right after its own paint, every time it paints.
  await act(async () => value!.setAppearance('light'))
  // The REAL underlying selection did change...
  expect(localStorage.getItem('tau-appearance')).toBe('light')
  // ...but the editor's own draft (still on its own independent 'Dark' tab)
  // is what's actually on screen, reapplied after that real repaint.
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})

test('the editor draft preview survives a storage event from another tab while editing', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // Simulate another tab/window changing the appearance: a real storage
  // event, exactly like the browser dispatches on a cross-document write.
  await act(async () => {
    localStorage.setItem('tau-appearance', 'light')
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'tau-appearance', newValue: 'light' }))
  })
  expect(localStorage.getItem('tau-appearance')).toBe('light')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})

test('the editor draft preview survives remote account-sync adoption while editing', async () => {
  let store: ReturnType<typeof useThemeSyncStore> | undefined
  const { container } = await render({
    preset: existing,
    appearance: 'dark',
    onReady: (_value, s) => {
      store = s
    },
  })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // A different account preference (server-adopted, e.g. "Use this device's
  // theme everywhere") lands while the editor is open. This connects a fake
  // sync API and drives the real adoptSynced()/refresh() flow — the same
  // codepath ThemeAccountSync uses — rather than a synthetic stand-in.
  const adopted = { themeId: 'ember', appearance: 'light' as const, customTheme: null, presetId: null }
  const api = {
    getMine: async () => ({ userId: 'u1', theme: adopted }),
    updateMine: async (input: { theme: typeof adopted }) => ({ userId: 'u1', theme: input.theme }),
  }
  await act(async () => {
    store!.connect(api)
    await store!.refresh()
  })
  await act(async () => {
    store!.adoptSynced()
    await store!.refresh()
  })
  // The REAL underlying selection adopted the remote preference...
  expect(store!.getSnapshot().selection).toEqual({ themeId: 'ember', appearance: 'light' })
  // ...but the editor's own draft (still on 'harbor'/'Dark', its own tab) is
  // what's actually on screen, reapplied after that real repaint.
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})
