import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { Modal, VIEWPORT_MODAL_HEIGHT } from './Modal'

async function renderModal(size?: 'default' | 'viewport') {
  const dom = await acquireDomHarness({})
  const rendered = dom.createRoot()
  await dom.act(async () =>
    rendered.root.render(
      <Modal isOpen onClose={() => undefined} title="Layout probe" size={size}>
        Content
      </Modal>
    )
  )
  return { dom, rendered, panel: dom.window.document.querySelector<HTMLElement>('[data-modal-size]')! }
}

test('default modal has no viewport geometry', async () => {
  const { dom, panel } = await renderModal()
  try {
    expect(panel.dataset.modalSize).toBe('default')
    const style = panel.getAttribute('style') ?? ''
    expect(style).not.toContain(VIEWPORT_MODAL_HEIGHT)
    expect(style).not.toContain('calc(100vw - 2rem)')
  } finally {
    await dom.cleanup()
  }
})

test('viewport modal applies observable viewport geometry', async () => {
  const { dom, panel } = await renderModal('viewport')
  try {
    expect(panel.dataset.modalSize).toBe('viewport')
    // Happy DOM drops dvh/env() from CSSStyleDeclaration properties but preserves the
    // rendered style attribute, which proves Modal actually applies its selected map.
    const style = panel.getAttribute('style') ?? ''
    expect(style).toContain(VIEWPORT_MODAL_HEIGHT)
    expect(style).toContain('calc(100vw - 2rem)')
  } finally {
    await dom.cleanup()
  }
})

test('mobile fullscreen follows keyboard viewport changes and removes its listeners on close', async () => {
  const dom = await acquireDomHarness({})
  const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  const viewport = new dom.window.EventTarget()
  Object.assign(viewport, { height: 812, offsetTop: 0 })
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <Modal isOpen mobileFullscreen title="Chat" onClose={() => undefined}>
          Conversation
        </Modal>
      )
    )
    const overlay = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(overlay.style.getPropertyValue('--chat-viewport-height')).toBe('812px')
    Object.assign(viewport, { height: 420, offsetTop: 22 })
    viewport.dispatchEvent(new dom.window.Event('resize'))
    expect(overlay.style.getPropertyValue('--chat-viewport-height')).toBe('420px')
    expect(overlay.style.getPropertyValue('--chat-viewport-top')).toBe('22px')
    await dom.act(async () => root.unmount())
    Object.assign(viewport, { height: 812 })
    viewport.dispatchEvent(new dom.window.Event('resize'))
    expect(overlay.style.getPropertyValue('--chat-viewport-height')).toBe('420px')
  } finally {
    if (previous) Object.defineProperty(window, 'visualViewport', previous)
    else Reflect.deleteProperty(window, 'visualViewport')
    await dom.cleanup()
  }
})

test('a never-opened modal renders no portal in a static render even when a DOM is available', async () => {
  const dom = await acquireDomHarness({})
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    expect(
      renderToStaticMarkup(
        <Modal isOpen={false} onClose={() => undefined}>
          Closed
        </Modal>
      )
    ).toBe('')
  } finally {
    await dom.cleanup()
  }
})
