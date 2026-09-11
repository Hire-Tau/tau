import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { acquireDomHarness } from '../test/domHarness'

async function installWindow(width: number) {
  return acquireDomHarness({
    url: 'http://localhost/',
    windowOptions: { innerWidth: width, innerHeight: 800 },
    configureWindow(window) {
      ;(window as any).matchMedia = (query: string) => ({
        matches: query === '(min-width: 768px)' ? width >= 768 : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      })
    },
  })
}

describe('useIsDesktop', () => {
  test('returns true when viewport matches the desktop breakpoint', async () => {
    const dom = await installWindow(1024)
    const { window } = dom
    try {
      const { useIsDesktop } = await import('./useIsDesktop')
      let observed: boolean | null = null

      function Probe() {
        observed = useIsDesktop()
        return null
      }

      const { root } = dom.createRoot()
      await dom.act(async () => root.render(createElement(Probe)))

      expect(observed).toBe(true)
      await dom.act(async () => root.unmount())
    } finally {
      await dom.cleanup()
    }
  })

  test('returns false below the desktop breakpoint', async () => {
    const dom = await installWindow(375)
    const { window } = dom
    try {
      const { useIsDesktop } = await import('./useIsDesktop')
      let observed: boolean | null = null

      function Probe() {
        observed = useIsDesktop()
        return null
      }

      const { root } = dom.createRoot()
      await dom.act(async () => root.render(createElement(Probe)))

      expect(observed).toBe(false)
      await dom.act(async () => root.unmount())
    } finally {
      await dom.cleanup()
    }
  })
})
