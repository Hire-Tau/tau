import { afterEach, expect, test } from 'bun:test'
import { act, StrictMode } from 'react'
import { fireEvent, getByRole } from '@testing-library/dom'
import { readFileSync } from 'node:fs'
import { acquireDomHarness } from '../test/domHarness'
import { ThemeProvider, useTheme, useThemeSyncStore } from './ThemeProvider'
import { ThemeAccountSyncSession } from './ThemeAccountSync'
import { ThemeControl } from '../components/settings/ThemeControl'
import type { ThemeSyncStore, ThemeSyncApi } from '../theme/sync'
import type { ThemePreference } from '@tau/shared'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
let store: ThemeSyncStore
function Picker() {
  store = useThemeSyncStore()
  return <ThemeControl value={useTheme()} />
}
async function harness() {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  globalThis.requestAnimationFrame = (fn) => {
    frames.set(++id, fn)
    return id
  }
  globalThis.cancelAnimationFrame = (key) => {
    frames.delete(key)
  }
  cleanup = async () => {
    await dom.cleanup()
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
  const paint = async () => {
    const batch = [...frames.values()]
    frames.clear()
    await act(async () => {
      for (const frame of batch) frame(0)
    })
  }
  return { ...dom.createRoot(), paint }
}
function fixture() {
  let theme: ThemePreference = { themeId: 'harbor', appearance: 'dark', customTheme: null }
  let reads = 0
  const writes: ThemePreference[] = []
  const api: ThemeSyncApi = {
    getMine: async () => {
      reads++
      return { userId: 'A', theme }
    },
    updateMine: async (input) => {
      writes.push(input.theme)
      theme = input.theme
      return { userId: 'A', theme }
    },
  }
  return {
    api,
    reads: () => reads,
    writes,
    set: (value: ThemePreference) => {
      theme = value
    },
  }
}

test('cold load preserves pre-paint local theme across differing server fetch, strict effects and reconnect; no flash/echo loop', async () => {
  const { root, container, paint } = await harness()
  localStorage.setItem('tau-theme-id', 'ember')
  localStorage.setItem('tau-appearance', 'light')
  const script = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(
    /<script data-tau-theme-flash>([\s\S]*?)<\/script>/
  )![1]!
  new Function('window', 'document', 'localStorage', script)(window, document, localStorage)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  const remote = fixture()
  await act(async () =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <ThemeAccountSyncSession sessionKey={1} api={remote.api} />
          <Picker />
        </ThemeProvider>
      </StrictMode>
    )
  )
  expect(remote.reads()).toBe(0)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  await paint()
  expect(remote.reads()).toBe(0)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  await paint()
  expect(remote.reads()).toBe(1)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  expect(container.textContent).toContain('This device overrides your synced theme')
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await store.refresh()
  })
  expect(remote.reads()).toBe(2)
  expect(remote.writes).toHaveLength(0)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  await act(async () => {
    fireEvent.click(getByRole(container, 'button', { name: 'Use synced theme' }))
    await store.refresh()
  })
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(container.textContent).toContain('Following your account theme.')
  expect(remote.writes).toHaveLength(0)
})
test('fresh device adopts only after paint; logout removes inherited document and scheduled/late requests cannot follow the next session', async () => {
  const { root, paint } = await harness()
  const remote = fixture()
  const render = (key: number | null | undefined) => (
    <ThemeProvider>
      <ThemeAccountSyncSession sessionKey={key} api={remote.api} />
      <Picker />
    </ThemeProvider>
  )
  await act(async () => root.render(render(undefined)))
  await paint()
  await paint()
  expect(remote.reads()).toBe(0)
  await act(async () => root.render(render(1)))
  await paint()
  await act(async () => root.render(render(null)))
  await paint()
  expect(remote.reads()).toBe(0)
  await act(async () => root.render(render(2)))
  await paint()
  await paint()
  expect(remote.reads()).toBe(1)
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  await act(async () => root.render(render(null)))
  expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  expect(store.getSnapshot().syncAvailable).toBe(false)
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await store.refresh()
  })
  expect(remote.reads()).toBe(1)
})
