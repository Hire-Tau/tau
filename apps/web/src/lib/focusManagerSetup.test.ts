import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, test } from 'bun:test'
import { focusManager } from '@tanstack/react-query'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

async function installWindow() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/' }))
}

afterEach(() => {
  // Reset the singleton focus manager to a no-op listener between tests.
  focusManager.setEventListener(() => undefined)
})

describe('setupFocusManager', () => {
  for (const eventType of ['pageshow', 'focus', 'visibilitychange']) {
    test(`notifies focused listeners on ${eventType}`, async () => {
      const dom = await installWindow()
      const { window } = dom
      const { setupFocusManager } = await import('./focusManagerSetup')
      setupFocusManager()

      let focused: boolean | null = null
      const unsubscribe = focusManager.subscribe((isFocused) => {
        focused = isFocused
      })

      window.dispatchEvent(new window.Event(eventType))

      expect(focused).toBe(true)
      unsubscribe()
    })
  }

  test('removes its listeners on cleanup', async () => {
    const dom = await installWindow()
    const { window } = dom
    const removed: string[] = []
    const originalRemoveEventListener = window.removeEventListener.bind(window)
    window.removeEventListener = ((type: string, ...rest: Parameters<typeof window.removeEventListener>) => {
      removed.push(type)
      return originalRemoveEventListener(type, ...rest)
    }) as typeof window.removeEventListener

    const { setupFocusManager } = await import('./focusManagerSetup')
    setupFocusManager()

    // Replacing the event listener triggers cleanup of the previous one.
    focusManager.setEventListener(() => undefined)

    expect(removed).toContain('visibilitychange')
    expect(removed).toContain('focus')
    expect(removed).toContain('pageshow')
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
