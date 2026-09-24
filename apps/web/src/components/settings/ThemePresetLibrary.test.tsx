import { afterEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ThemePreset } from '@tau/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme } from '../../providers/ThemeProvider'
import { ThemePresetLibrary } from './ThemePresetLibrary'
import { themePresetQueryKeys } from '../../queryKeys'
import { client } from '../../api/clientInstance'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const mine: ThemePreset = {
  id: 'preset-1',
  document: {
    format: 'tau-custom-theme',
    version: 2,
    name: 'Mine',
    base: 'harbor',
    variants: { light: {}, dark: {} },
  },
  visibility: 'private',
  ownerUserId: 'u1',
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function Harness() {
  const value = useTheme()
  return <ThemePresetLibrary value={value} />
}

async function render(presets: ThemePreset[]) {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list(), presets)
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  return { container, queryClient }
}

test('with no presets, shows an empty state', async () => {
  const { container } = await render([])
  expect(container.textContent).toContain('You have no saved theme presets yet.')
})

test('lists a preset with its name, and applies it via Use (applyPreset)', async () => {
  const { container } = await render([mine])
  expect(container.textContent).toContain('Mine')
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Use' })))
  expect(localStorage.getItem('tau-theme-preset-id')).toBe('preset-1')
  expect(localStorage.getItem('tau-theme-id')).toBe('harbor')
})

test('Duplicate posts a copy with a suffixed name', async () => {
  const create = spyOn(client.themePresets, 'create').mockResolvedValue({ ...mine, id: 'preset-2' })
  try {
    const { container } = await render([mine])
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Duplicate' })))
    expect(create).toHaveBeenCalledTimes(1)
    const [document] = create.mock.calls[0]!
    expect((document as { name: string }).name).toBe('Mine copy')
  } finally {
    create.mockRestore()
  }
})

test('Rename shows an inline form and sends a PUT with the current revision', async () => {
  const update = spyOn(client.themePresets, 'update').mockResolvedValue({
    ...mine,
    document: { ...mine.document, name: 'Renamed' },
    revision: 2,
  })
  try {
    const { container } = await render([mine])
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Rename' })))
    const input = container.querySelector('input.tau-field') as HTMLInputElement
    await act(async () => fireEvent.change(input, { target: { value: 'Renamed' } }))
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Save' })))
    expect(update).toHaveBeenCalledWith('preset-1', 1, expect.objectContaining({ name: 'Renamed' }))
  } finally {
    update.mockRestore()
  }
})

test('Delete asks for confirmation, then sends the revision', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    let confirmed = false
    window.confirm = () => {
      confirmed = true
      return true
    }
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Delete' })))
    expect(confirmed).toBe(true)
    expect(remove).toHaveBeenCalledWith('preset-1', 1)
  } finally {
    remove.mockRestore()
  }
})

test('Delete does nothing when the confirmation is declined', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    window.confirm = () => false
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Delete' })))
    expect(remove).not.toHaveBeenCalled()
  } finally {
    remove.mockRestore()
  }
})

test('New theme opens the editor for a fresh document based on the selected base', async () => {
  const { container } = await render([])
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'New theme' })))
  expect(queryByRole(container, 'textbox', { name: 'Theme name' })).not.toBeNull()
})

test('a palette-only preset (no explicit overrides) still resolves a real swatch color, not an empty circle', async () => {
  const { palettes, resolveToken } = await import('../../theme/test/builtins')
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  const style = document.createElement('style')
  style.textContent = palettes
    .map((p) => {
      const attrs = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
      return `:root${attrs}, [data-theme-scope]${attrs} { ${Object.entries(p.tokens)
        .map(([key]) => `${key}: ${resolveToken(p.tokens, key)};`)
        .join(' ')} }`
    })
    .join('\n')
  document.head.append(style)
  const paletteOnly: ThemePreset = {
    id: 'preset-2',
    document: {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Palette only',
      base: 'harbor',
      palette: { primary: '#0ea5e9' },
      variants: { light: {}, dark: {} },
    },
    visibility: 'private',
    ownerUserId: 'u1',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list(), [paletteOnly])
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  const swatch = container.querySelector('[data-theme-scope]')!
  const resolvedPrimary = window.getComputedStyle(swatch).getPropertyValue('--color-primary').trim()
  expect(resolvedPrimary).not.toBe('')
  // Not the plain Harbor base primary (proves derivation ran, not a fallback)...
  expect(resolvedPrimary).not.toBe('14 95 109')
  // ...and recognizably derived FROM the seed (#0ea5e9): a blue hue, not the
  // exact seed necessarily (a contrast pass may nudge lightness), but well
  // within the blue family, never a neutral/gray/other-hue washout.
  const { srgbToOklch } = await import('@tau/shared/color-oklch')
  const [r, g, b] = resolvedPrimary.split(/\s+/).map(Number)
  const oklch = srgbToOklch([r!, g!, b!])
  expect(oklch.h).toBeGreaterThan(200)
  expect(oklch.h).toBeLessThan(260)
  expect(oklch.c).toBeGreaterThan(0.05)
})

test('the swatch element carries the shared theme-swatch paint class (regression: a missing class left it visually blank)', async () => {
  const { container } = await render([mine])
  const swatch = container.querySelector('[data-theme-scope]')!
  expect(swatch.classList.contains('theme-swatch')).toBe(true)
})
