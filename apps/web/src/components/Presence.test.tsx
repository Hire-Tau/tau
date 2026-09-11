import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { Presence } from './Presence'

test('dismissed menus become inert immediately, finish their exit, and can reopen during an exit', async () => {
  const dom = await acquireDomHarness({})
  try {
    const { root, container } = dom.createRoot()
    const render = (open: boolean) =>
      root.render(
        <Presence open={open}>
          <button>Action</button>
        </Presence>
      )
    await dom.act(async () => render(false))
    expect(container.children).toHaveLength(0)
    await dom.act(async () => render(true))
    const surface = container.firstElementChild!
    expect(surface.getAttribute('data-state')).toBe('open')
    await dom.act(async () => render(false))
    expect(surface.hasAttribute('inert')).toBe(true)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    await dom.act(async () => render(true))
    expect(surface.hasAttribute('inert')).toBe(false)
    await dom.act(async () => surface.dispatchEvent(new dom.window.Event('animationend', { bubbles: true })))
    expect(container.children).toHaveLength(1)
    await dom.act(async () => render(false))
    await dom.act(async () => surface.dispatchEvent(new dom.window.Event('animationend', { bubbles: true })))
    expect(container.children).toHaveLength(0)
  } finally {
    await dom.cleanup()
  }
})
