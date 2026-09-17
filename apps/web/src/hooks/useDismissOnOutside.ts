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
 * The implication of `stopImmediatePropagation` with several instances open at once: they all
 * listen on `document` in the capture phase, so the FIRST-REGISTERED open popover consumes the key
 * and closes, and the others stay open until the next press. That is the right behavior for the
 * nested case this protects (inner before outer), and harmless for siblings, which cannot both be
 * open under a pointer-dismiss policy — but it is registration order, not DOM nesting, that
 * decides, so do not rely on it for a deliberately stacked UI.
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
