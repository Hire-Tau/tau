import { useEffect, type RefObject } from 'react'

export interface VisualViewportLike {
  height: number
  offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

export interface VisualViewportShellDependencies {
  viewport?: VisualViewportLike | null
  /** Layout viewport height the visual viewport is compared against. */
  innerHeight?: () => number
  /** Reset the visual viewport's own scroll offset (Safari scrolls fixed pages to reveal inputs). */
  resetScroll?: () => void
}

/** Below this many pixels of difference the visual viewport is treated as full height (browser chrome jitter). */
export const KEYBOARD_OPEN_THRESHOLD_PX = 80

/** Pure decision: should the shell be pinned to the visual viewport height? */
export function keyboardShellHeight(viewportHeight: number, layoutHeight: number): number | null {
  return layoutHeight - viewportHeight > KEYBOARD_OPEN_THRESHOLD_PX ? Math.round(viewportHeight) : null
}

/**
 * Keep the fixed app shell the size of the visible area while the software keyboard is open.
 *
 * `html`/`body`/`#root` are locked to 100% and the body is `position: fixed`, so the layout
 * viewport does not shrink when iOS shows the keyboard. Safari then scrolls the visual viewport
 * over the fixed page to reveal the focused composer, which drags the whole shell (composer, dock,
 * everything) upward and leaves a blank band where the shell extends under the keyboard. Sizing
 * the shell to the visual viewport and resetting that scroll keeps the composer just above the
 * keyboard with the transcript scrolling inside. Desktop browsers never trip the threshold.
 */
export function useVisualViewportShell(
  ref: RefObject<HTMLElement | null>,
  dependencies: VisualViewportShellDependencies = {}
): void {
  useEffect(() => {
    const viewport =
      dependencies.viewport !== undefined
        ? dependencies.viewport
        : typeof window === 'undefined'
          ? null
          : (window.visualViewport as VisualViewportLike | null)
    if (!viewport) return
    const innerHeight = dependencies.innerHeight ?? (() => window.innerHeight)
    const resetScroll = dependencies.resetScroll ?? (() => window.scrollTo(0, 0))
    const update = () => {
      const element = ref.current
      if (!element) return
      const height = keyboardShellHeight(viewport.height, innerHeight())
      if (height === null) {
        element.style.removeProperty('height')
        element.style.removeProperty('max-height')
        delete element.dataset.keyboard
      } else {
        element.style.height = `${height}px`
        element.style.maxHeight = `${height}px`
        element.dataset.keyboard = 'open'
      }
      // Whatever the browser scrolled to reveal the input is now inside the shell; undo the shift.
      if (viewport.offsetTop > 0) resetScroll()
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      const element = ref.current
      if (!element) return
      element.style.removeProperty('height')
      element.style.removeProperty('max-height')
      delete element.dataset.keyboard
    }
  }, [ref, dependencies.viewport, dependencies.innerHeight, dependencies.resetScroll])
}
