import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByLabelText, getByRole, getAllByRole, queryByRole } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme } from '../../providers/ThemeProvider'
import { ThemeControl } from './ThemeControl'
import { palettes, resolveToken } from '../../theme/test/builtins'
import { CUSTOM_THEME_KEY } from '../../theme/custom'
import { STATUS_TOKENS, type CustomThemeDocument } from '@tau/shared'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
const doc: CustomThemeDocument = {
  format: 'tau-custom-theme',
  version: 1,
  name: 'Imported',
  base: 'harbor',
  appearance: 'dark',
  overrides: { '--color-text-primary': '#ffffff', '--color-bg-surface': '#ffffff' },
}
function Control() {
  return <ThemeControl value={useTheme()} />
}
async function render(raw?: string) {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  if (raw) localStorage.setItem(CUSTOM_THEME_KEY, raw)
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
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Control />
      </ThemeProvider>
    )
  )
  return container
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
async function importFile(container: HTMLElement, json: string) {
  await act(async () => {
    fireEvent.change(getByLabelText(container, 'Import theme JSON'), {
      target: { files: [{ size: json.length, text: async () => json }] },
    })
  })
}

test('import previews without root mutation; contrast never blocks apply; safe-value, export, apply and reset', async () => {
  const container = await render()
  await click(container, 'Edit custom theme')
  const before = document.documentElement.getAttribute('style')
  await importFile(container, JSON.stringify(doc))
  expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  expect(document.documentElement.getAttribute('style')).toBe(before)
  expect(localStorage.getItem(CUSTOM_THEME_KEY)).toBeNull()
  expect(getByLabelText(container, 'Custom theme preview').getAttribute('data-theme')).toBe('harbor')
  expect(queryByRole(container, 'button', { name: 'Apply custom theme' })?.hasAttribute('disabled')).toBe(false)
  const warnings = getByLabelText(container, 'Contrast warnings')
  expect(warnings.textContent).toContain('1.00:1')
  await act(async () => fireEvent.click(getAllByRole(warnings, 'button')[0]!))
  const preview = getByLabelText(container, 'Custom theme preview')
  expect(preview.style.getPropertyValue('--color-text-primary')).toBe('0 0 0')
  await click(container, 'Apply custom theme')
  const saved = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY)!)
  expect(saved.base).toBe('harbor')
  expect(saved.overrides['--color-text-primary']).toBe('#000000')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 0 0')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  let blob: Blob | undefined
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = (value) => {
    blob = value as Blob
    return 'blob:test'
  }
  URL.revokeObjectURL = () => undefined
  try {
    await click(container, 'Export JSON')
    expect(JSON.parse(await blob!.text())).toEqual(saved)
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
  await click(container, 'Reset to default')
  expect(localStorage.getItem(CUSTOM_THEME_KEY)).toBeNull()
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('')
  expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
  expect(container.querySelector('[data-theme-scope]')).toBeNull()
})

test('bad imports leave active theme intact, unknown names warn, status picker authors/removes complete grid', async () => {
  const container = await render(JSON.stringify({ ...doc, overrides: {} }))
  await click(container, 'Edit custom theme')
  await importFile(container, JSON.stringify({ ...doc, overrides: { '--color-primary': 'url(https://evil.test)' } }))
  expect(getByRole(container, 'status').textContent).toContain('Invalid color')
  expect(JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY)!).overrides).toEqual({})
  await importFile(container, JSON.stringify({ ...doc, overrides: { '--future-token': '#123' } }))
  expect(getByRole(container, 'status').textContent).toContain('Ignored unknown')
  await change(container, 'Color token', '--status-danger-fg')
  await click(container, 'Preview token')
  const preview = getByLabelText(container, 'Custom theme preview')
  for (const token of STATUS_TOKENS) expect(preview.style.getPropertyValue(token)).not.toBe('')
  await click(container, 'Remove --status-danger-fg')
  for (const token of STATUS_TOKENS) expect(preview.style.getPropertyValue(token)).toBe('')
  await change(container, 'Appearance', 'light')
  expect(localStorage.getItem(CUSTOM_THEME_KEY)).toBeNull()
})

test('provider load recovers to declared base and clears broken storage', async () => {
  const container = await render(JSON.stringify({ ...doc, version: 22 }))
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(localStorage.getItem(CUSTOM_THEME_KEY)).toBeNull()
  expect(getByRole(container, 'alert').textContent).toContain('version 1')
})

test('provider recovers on apply exception without keeping partial overrides or a reload loop', async () => {
  const container = await render()
  await click(container, 'Edit custom theme')
  await importFile(container, JSON.stringify(doc))
  const root = document.documentElement
  const original = root.style.setProperty.bind(root.style)
  root.style.setProperty = (name, value, priority) => {
    if (name === '--color-text-primary') throw new Error('apply failed')
    original(name, value, priority)
  }
  await click(container, 'Apply custom theme')
  expect(localStorage.getItem(CUSTOM_THEME_KEY)).toBeNull()
  expect(root.style.getPropertyValue('--color-text-primary')).toBe('')
  expect(root.getAttribute('data-theme')).toBe('harbor')
  expect(getByRole(container, 'alert').textContent).toContain('Restored its base theme')
})

function surfaceWarning(container: HTMLElement): HTMLLIElement | undefined {
  return [...container.querySelectorAll<HTMLLIElement>('[aria-label="Contrast warnings"] li')].find((li) =>
    li.textContent?.startsWith('--color-text-primary on --color-bg-surface:')
  )
}

test('transparent preview surface uses its page backdrop; safe action improves rather than reverses contrast', async () => {
  const container = await render()
  await click(container, 'Edit custom theme')
  const transparent = {
    ...doc,
    base: 'tau',
    appearance: 'dark',
    overrides: { '--color-bg-surface': 'rgba(255,255,255,0)', '--color-text-primary': '#ffffff' },
  }
  await importFile(container, JSON.stringify(transparent))
  expect(surfaceWarning(container)).toBeUndefined()
  // The actual preview renders a page scope outside the translucent surface.
  expect(getByLabelText(container, 'Preview surface').parentElement).toBe(
    getByLabelText(container, 'Custom theme preview')
  )
  await importFile(
    container,
    JSON.stringify({ ...transparent, overrides: { ...transparent.overrides, '--color-text-primary': '#000000' } })
  )
  const warning = surfaceWarning(container)!
  expect(warning.textContent).toContain('1.06:1')
  await click(warning, 'Use safe value #ffffff')
  expect(getByLabelText(container, 'Custom theme preview').style.getPropertyValue('--color-text-primary')).toBe(
    '255 255 255'
  )
  expect(surfaceWarning(container)).toBeUndefined()
  expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
})

test('unresolved backdrop explains uncertainty without safe-value claims or blocking Apply', async () => {
  const container = await render()
  await click(container, 'Edit custom theme')
  await importFile(
    container,
    JSON.stringify({
      ...doc,
      overrides: { '--color-bg-page': 'rgba(0,0,0,0.5)', '--color-bg-surface': 'rgba(255,255,255,0)' },
    })
  )
  const warning = surfaceWarning(container)!
  expect(warning.textContent).toContain('Contrast unknown')
  expect(warning.querySelector('button')).toBeNull()
  expect(getByRole(container, 'button', { name: 'Apply custom theme' }).hasAttribute('disabled')).toBe(false)
})

test('tiny valid alpha still produces a low-contrast warning and an opaque safe-value action', async () => {
  const container = await render()
  await click(container, 'Edit custom theme')
  await importFile(
    container,
    JSON.stringify({
      ...doc,
      overrides: { '--color-bg-surface': '#000000', '--color-text-primary': 'rgba(255,255,255,0.0000001)' },
    })
  )
  const warning = surfaceWarning(container)!
  expect(warning.textContent).toContain('1.00:1')
  await click(warning, 'Use safe value #ffffff')
  expect(surfaceWarning(container)).toBeUndefined()
  expect(getByRole(container, 'button', { name: 'Apply custom theme' }).hasAttribute('disabled')).toBe(false)
})
