import { expect, mock, test } from 'bun:test'
import { useRef } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  keyboardShellHeight,
  useVisualViewportShell,
  type VisualViewportLike,
} from './useVisualViewportShell'

test('the shell pins to the visual viewport only when the difference looks like a keyboard', () => {
  expect(keyboardShellHeight(812, 812)).toBeNull()
  expect(keyboardShellHeight(812 - KEYBOARD_OPEN_THRESHOLD_PX, 812)).toBeNull()
  expect(keyboardShellHeight(500.4, 812)).toBe(500)
})

function fakeViewport(height: number): VisualViewportLike & { emit: (type: 'resize' | 'scroll') => void } {
  const listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() }
  return {
    height,
    offsetTop: 0,
    addEventListener: (type, listener) => listeners[type].add(listener),
    removeEventListener: (type, listener) => listeners[type].delete(listener),
    emit: (type) => listeners[type].forEach((listener) => listener()),
  }
}

test('opening the keyboard sizes the shell to the visible area and undoes the page scroll; closing restores it', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const viewport = fakeViewport(812)
  const resetScroll = mock(() => {})
  let shell: HTMLDivElement | null = null
  function Shell() {
    const ref = useRef<HTMLDivElement>(null)
    useVisualViewportShell(ref, { viewport, innerHeight: () => 812, resetScroll })
    return (
      <div
        ref={(node) => {
          ref.current = node
          shell = node
        }}
        className="h-full"
      />
    )
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () => root.render(<Shell />))
    expect(shell!.style.height).toBe('')
    expect(shell!.dataset.keyboard).toBeUndefined()
    // Keyboard opens: Safari shrinks the visual viewport and scrolls the fixed page to the input.
    viewport.height = 470
    viewport.offsetTop = 342
    await dom.act(async () => viewport.emit('resize'))
    expect(shell!.style.height).toBe('470px')
    expect(shell!.style.maxHeight).toBe('470px')
    expect(shell!.dataset.keyboard).toBe('open')
    expect(resetScroll).toHaveBeenCalledTimes(1)
    // A later visual-viewport scroll with no offset does nothing extra.
    viewport.offsetTop = 0
    await dom.act(async () => viewport.emit('scroll'))
    expect(resetScroll).toHaveBeenCalledTimes(1)
    // Keyboard closes: the shell returns to the CSS-driven full height.
    viewport.height = 812
    await dom.act(async () => viewport.emit('resize'))
    expect(shell!.style.height).toBe('')
    expect(shell!.dataset.keyboard).toBeUndefined()
    await dom.act(async () => root.unmount())
  } finally {
    await dom.cleanup()
  }
})
