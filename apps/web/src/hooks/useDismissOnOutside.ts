import { useEffect, type RefObject } from 'react'

/**
 * Dismisses an open popover the two ways a native `<details>` does not: Escape (which returns
 * focus to the trigger, so the keyboard user is not dropped at the top of the document) and a
 * pointer press anywhere outside it. Listeners are attached only while open, so a page of closed
 * menus costs nothing.
 *
 * Escape is handled in the CAPTURE phase and calls `stopImmediatePropagation`, so the innermost
 * open popover consumes the key and nothing else on the way down acts on the same press. Plain
 * `stopPropagation` would not be enough: it leaves other listeners already registered on the same
 * target free to run. Today's modals close on a backdrop click rather than on Escape, so this is
 * about future-proofing the nesting, not about a handler that exists now.
 *
 * `apps/web/src/components/AgentViewTabs.tsx` and `WorkStreamFiltersPopover.tsx` still carry their
 * own inline copies of this shape; adopting this hook there is a follow-up.
 */
export function useDismissOnOutside(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
) {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onDismiss()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, containerRef, triggerRef, onDismiss])
}
