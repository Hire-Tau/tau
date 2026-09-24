import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { PullToRefresh } from './PullToRefresh'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/' }))
}

function touchEvent(window: Awaited<ReturnType<typeof acquireDomHarness>>['window'], type: string, clientY: number) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientY }],
  })
  Object.defineProperty(event, 'changedTouches', {
    value: [{ clientY }],
  })
  return event
}

async function renderPullToRefresh(
  onRefresh: () => Promise<void> | void,
  children: ReactNode = <div>Scrollable content</div>,
  window?: Awaited<ReturnType<typeof acquireDomHarness>>['window']
) {
  if (!window) window = (await installDom()).window
  const { root, container: element } = domHarness!.createRoot()

  await domHarness!.act(async () => {
    root.render(
      <PullToRefresh id="test-pull-refresh" onRefresh={onRefresh} label="Test content" data-testid="test-pull-refresh">
        {children}
      </PullToRefresh>
    )
  })
  await domHarness!.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  return { window, root, target: window.document.getElementById('test-pull-refresh') as HTMLElement }
}

describe('PullToRefresh', () => {
  test('renders a brand purple refresh indicator for mobile pull gestures', () => {
    const html = renderToStaticMarkup(
      <PullToRefresh onRefresh={() => undefined} label="Feed" data-testid="feed-pull-to-refresh">
        <div>Feed rows</div>
      </PullToRefresh>
    )

    expect(html).toContain('data-testid="feed-pull-to-refresh"')
    expect(html).toContain('data-testid="pull-to-refresh-indicator"')
    expect(html).toContain('var(--brand-gradient-to)')
    expect(html).toContain('Pull to refresh Feed')
  })

  test('attaches touchmove as a non-passive native listener so preventDefault can suppress rubber-band overscroll', async () => {
    const dom = await installDom()
    const { window } = dom
    const originalAddEventListener = window.HTMLElement.prototype.addEventListener
    const touchMoveOptions: unknown[] = []
    window.HTMLElement.prototype.addEventListener = function (
      this: HTMLElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) {
      if (this.id === 'test-pull-refresh' && type === 'touchmove') touchMoveOptions.push(options)
      return originalAddEventListener.call(this, type, listener, options)
    }

    try {
      const { root } = await renderPullToRefresh(() => undefined, undefined, window)

      expect(touchMoveOptions).toContainEqual({ passive: false })

      await domHarness!.act(async () => {
        root.unmount()
      })
    } finally {
      window.HTMLElement.prototype.addEventListener = originalAddEventListener
    }
  })

  test('pulling down past the threshold at the top calls onRefresh once', async () => {
    let finishRefresh: () => void = () => undefined
    const onRefresh = mock(() => new Promise<void>((resolve) => (finishRefresh = resolve)))
    const { window, root, target } = await renderPullToRefresh(onRefresh)

    Object.defineProperty(target, 'scrollTop', { value: 0, configurable: true })

    await domHarness!.act(async () => {
      target.dispatchEvent(touchEvent(window, 'touchstart', 10))
      target.dispatchEvent(touchEvent(window, 'touchmove', 95))
      target.dispatchEvent(touchEvent(window, 'touchend', 95))
      await Promise.resolve()
    })

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(window.document.body.textContent).toContain('Refreshing Test content')

    await domHarness!.act(async () => {
      finishRefresh()
      await Promise.resolve()
    })
    expect(window.document.body.textContent).not.toContain('Refreshing Test content')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('does not refresh when the scroll container is not at the top', async () => {
    const onRefresh = mock(() => undefined)
    const { window, root, target } = await renderPullToRefresh(onRefresh)

    Object.defineProperty(target, 'scrollTop', { value: 12, configurable: true })

    await domHarness!.act(async () => {
      target.dispatchEvent(touchEvent(window, 'touchstart', 10))
      target.dispatchEvent(touchEvent(window, 'touchmove', 120))
      target.dispatchEvent(touchEvent(window, 'touchend', 120))
      await Promise.resolve()
    })

    expect(onRefresh).not.toHaveBeenCalled()

    await domHarness!.act(async () => {
      root.unmount()
    })
  })

  test('uses the nested touched scroll container when deciding whether refresh can start', async () => {
    const onRefresh = mock(() => undefined)
    const { window, root } = await renderPullToRefresh(
      onRefresh,
      <div id="nested-scroll" style={{ overflowY: 'auto' }}>
        Nested rows
      </div>
    )
    const nested = window.document.getElementById('nested-scroll') as HTMLElement
    Object.defineProperty(nested, 'scrollTop', { value: 20, configurable: true })
    Object.defineProperty(nested, 'scrollHeight', { value: 200, configurable: true })
    Object.defineProperty(nested, 'clientHeight', { value: 100, configurable: true })

    await domHarness!.act(async () => {
      nested.dispatchEvent(touchEvent(window, 'touchstart', 10))
      nested.dispatchEvent(touchEvent(window, 'touchmove', 120))
      nested.dispatchEvent(touchEvent(window, 'touchend', 120))
      await Promise.resolve()
    })

    expect(onRefresh).not.toHaveBeenCalled()

    await domHarness!.act(async () => {
      root.unmount()
    })
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
