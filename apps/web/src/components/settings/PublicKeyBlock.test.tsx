import { acquireDomHarness } from '../../test/domHarness'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { PublicKeyBlock } from './PublicKeyBlock'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

describe('PublicKeyBlock copy button interaction', () => {
  let window: Awaited<ReturnType<typeof acquireDomHarness>>['window']

  async function installDom() {
    domHarness = await acquireDomHarness({
      url: 'http://localhost/settings',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
    })
    window = domHarness.window
    return domHarness
  }

  test('clicking Copy writes the value to the clipboard and shows Copied feedback', async () => {
    const dom = await installDom()
    const { window } = dom
    const writeText = mock(() => Promise.resolve())
    // happy-dom's `navigator.clipboard` getter always returns the same
    // instance — shadow its `writeText` method rather than replacing
    // `navigator.clipboard` itself (that property has no setter).
    Object.assign(window.navigator.clipboard, { writeText })

    const { root, container: container } = domHarness!.createRoot()

    await domHarness!.act(async () => {
      root.render(<PublicKeyBlock value="ssh-ed25519 AAAA..." />)
    })

    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Copy')
    expect(button).toBeDefined()

    await domHarness!.act(async () => {
      fireEvent.click(button as unknown as Element)
    })

    expect(writeText).toHaveBeenCalledWith('ssh-ed25519 AAAA...')
    expect(container.textContent).toContain('Copied')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('clicking Copy does not show Copied feedback when the clipboard write rejects', async () => {
    const dom = await installDom()
    const { window } = dom
    const writeText = mock(() => Promise.reject(new Error('permission denied')))
    Object.assign(window.navigator.clipboard, { writeText })

    const { root, container: container } = domHarness!.createRoot()

    await domHarness!.act(async () => {
      root.render(<PublicKeyBlock value="ssh-ed25519 AAAA..." />)
    })

    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Copy')
    expect(button).toBeDefined()

    await domHarness!.act(async () => {
      fireEvent.click(button as unknown as Element)
    })
    // Let the rejected promise's .then/.catch handler run.
    await domHarness!.act(async () => {
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('ssh-ed25519 AAAA...')
    expect(container.textContent).not.toContain('Copied')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
