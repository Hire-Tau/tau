import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'

/**
 * The two-step confirm used for destructive row actions (removing a passkey,
 * stopping an agent): the first click ARMS the button, the second commits, and an
 * unconfirmed arm lapses on its own so a half-pressed button never sits primed.
 */
describe('ConfirmButton', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  let ConfirmButton: typeof import('./ConfirmButton').ConfirmButton

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
    })
    ;({ container, root } = dom.createRoot())
    ;({ ConfirmButton } = await import('./ConfirmButton'))
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  const button = () => container.querySelector('button')!
  const click = async () => {
    await dom.act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test('the first click only arms — it does not fire the action', async () => {
    const onConfirm = mock(() => {})
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={onConfirm} label="Remove" />)
    })
    expect(button().textContent).toBe('Remove')

    await click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button().textContent).toBe('Confirm?')
  })

  test('the second click confirms and returns the button to its resting label', async () => {
    const onConfirm = mock(() => {})
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={onConfirm} label="Remove" />)
    })

    await click()
    await click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Remove')
  })

  test('an unconfirmed arm reverts on its own after the timeout', async () => {
    const onConfirm = mock(() => {})
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={onConfirm} label="Remove" timeoutMs={30} />)
    })

    await click()
    expect(button().textContent).toBe('Confirm?')

    await dom.act(async () => {
      await sleep(60)
    })
    expect(button().textContent).toBe('Remove')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('a click after the arm has lapsed only re-arms, it does not remove', async () => {
    const onConfirm = mock(() => {})
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={onConfirm} label="Remove" timeoutMs={30} />)
    })

    await click()
    await dom.act(async () => {
      await sleep(60)
    })
    await click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button().textContent).toBe('Confirm?')
  })

  test('unmounting while armed clears the pending timer (no setState after unmount)', async () => {
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const armed: unknown[] = []
    const cleared: unknown[] = []
    // Spy on the pair so we can prove the id the component created is the id it
    // cancels — a leaked timer would fire setConfirming on an unmounted tree.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = realSetTimeout(fn, ms)
      armed.push(id)
      return id
    }) as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((id: unknown) => {
      cleared.push(id)
      return realClearTimeout(id as Parameters<typeof realClearTimeout>[0])
    }) as typeof globalThis.clearTimeout

    try {
      await dom.act(async () => {
        root.render(<ConfirmButton onConfirm={() => {}} label="Remove" timeoutMs={5000} />)
      })
      armed.length = 0
      await click()
      expect(armed).toHaveLength(1)

      await dom.act(async () => {
        root.unmount()
      })
      expect(cleared).toContain(armed[0])
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })

  test('a disabled button neither arms nor fires', async () => {
    const onConfirm = mock(() => {})
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={onConfirm} label="Remove" disabled />)
    })
    await click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button().textContent).toBe('Remove')
  })

  test('ariaLabel names the specific row while the visible label stays generic', async () => {
    await dom.act(async () => {
      root.render(<ConfirmButton onConfirm={() => {}} label="Remove" ariaLabel="Remove passkey YubiKey 5C" />)
    })
    expect(button().getAttribute('aria-label')).toBe('Remove passkey YubiKey 5C')
    expect(button().textContent).toBe('Remove')
  })
})
