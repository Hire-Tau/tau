import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme } from '../../providers/ThemeProvider'
import { ThemeControl } from './ThemeControl'
import { palettes, resolveToken } from '../../theme/test/builtins'
import { BUILT_IN_THEMES } from '../../theme/registry'
import { themePresetQueryKeys } from '../../queryKeys'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
function Control({ enabled }: { enabled: boolean }) {
  return <ThemeControl value={useTheme()} enabled={enabled} />
}
async function renderControl(themeId = 'tau', appearance = 'light', dark = false, enabled = true) {
  const dom = await acquireDomHarness({
    configureWindow: (window) => {
      window.matchMedia = (() => ({
        matches: dark,
        addEventListener() {},
        removeEventListener() {},
      })) as typeof window.matchMedia
    },
  })
  cleanup = () => dom.cleanup()
  localStorage.setItem('tau-theme-id', themeId)
  localStorage.setItem('tau-appearance', appearance)
  const sheet = document.createElement('style')
  sheet.textContent = palettes
    .map((p) => `${p.selector} { --color-bg-surface: ${resolveToken(p.tokens, '--color-bg-surface')}; }`)
    .join('\n')
  document.head.appendChild(sheet)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list(), [])
  const { root, container } = dom.createRoot()
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Control enabled={enabled} />
        </ThemeProvider>
      </QueryClientProvider>
    )
  })
  return container
}
test('two labelled keyboard-native controls; unified selection preserves and disables appearance', async () => {
  const container = await renderControl('harbor', 'system')
  const theme = getByLabelText(container, 'Color theme') as HTMLSelectElement
  const appearance = getByLabelText(container, 'Appearance') as HTMLSelectElement
  expect([...theme.options].map((option) => option.value)).toEqual(BUILT_IN_THEMES.map((t) => t.id))
  expect(appearance.value).toBe('system')
  await act(async () => {
    fireEvent.change(theme, { target: { value: 'high-contrast' } })
  })
  expect(appearance.disabled).toBe(true)
  expect(appearance.value).toBe('system')
  expect(document.documentElement.getAttribute('data-appearance')).toBeNull()
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(localStorage.getItem('tau-appearance')).toBe('system')
  expect(JSON.parse(localStorage.getItem('tau-theme-surface')!).appearance).toBe('constant')
  await act(async () => {
    fireEvent.change(theme, { target: { value: 'ember' } })
  })
  expect(appearance.disabled).toBe(false)
  expect(appearance.value).toBe('system')
  await act(async () => {
    fireEvent.change(appearance, { target: { value: 'dark' } })
  })
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(localStorage.getItem('tau-theme-id')).toBe('ember')
  expect(localStorage.getItem('tau-appearance')).toBe('dark')
})
for (const theme of BUILT_IN_THEMES)
  for (const appearance of ['light', 'dark', 'system'])
    for (const dark of [false, true]) {
      test(`${theme.id}/${appearance}/OS-dark=${dark}: provider surface, snapshot and meta sync before paint`, async () => {
        await renderControl(theme.id, appearance, dark)
        const resolved =
          theme.kind === 'unified' ? 'constant' : appearance === 'system' ? (dark ? 'dark' : 'light') : appearance
        const palette = palettes.find((p) => p.id === theme.id && p.appearance === resolved)!
        const surface = `rgb(${resolveToken(palette.tokens, '--color-bg-surface').split(/\s+/).join(', ')})`
        expect(document.documentElement.style.backgroundColor).toBe(surface)
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe(surface)
        expect(JSON.parse(localStorage.getItem('tau-theme-surface')!)).toEqual({
          theme: theme.id,
          appearance: resolved,
          surface,
        })
      })
    }

test('the "My themes" library section renders (Phase 1: owner-only, own presets)', async () => {
  const container = await renderControl('tau', 'light')
  expect(container.textContent).toContain('My themes')
  expect(getByRole(container, 'button', { name: 'New theme' })).not.toBeNull()
})

test('Reset to default clears any active custom theme/preset', async () => {
  const container = await renderControl('harbor', 'dark')
  localStorage.setItem(
    'tau-custom-theme',
    JSON.stringify({
      format: 'tau-custom-theme',
      version: 2,
      name: 'Mine',
      base: 'harbor',
      variants: { light: {}, dark: {} },
    })
  )
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Reset to default' })))
  expect(localStorage.getItem('tau-theme-id')).toBe('tau')
  expect(localStorage.getItem('tau-custom-theme')).toBeNull()
})

test('release flag rollback keeps a working legacy appearance toggle', async () => {
  const container = await renderControl('tau', 'light', false, false)
  expect(container.querySelector('select')).toBeNull()
  const button = container.querySelector('button')!
  expect(button.textContent).toBe('Dark Mode')
  await act(async () => {
    fireEvent.click(button)
  })
  expect(button.textContent).toBe('Light Mode')
  expect(localStorage.getItem('tau-appearance')).toBe('dark')
})
