import { focusManager } from '@tanstack/react-query'

/**
 * Augments TanStack Query's global focus manager so that queries refetch on
 * focus across all "app became active" signals — not just `visibilitychange`.
 *
 * In TanStack Query v5 the default focus manager only listens to
 * `visibilitychange`. That misses two important resume paths:
 * - `pageshow` — bfcache restore (common on iOS Safari / iOS PWA resume),
 *   where `visibilitychange` may not fire.
 * - `focus` — desktop window/tab focus where visibility doesn't change.
 *
 * Standard refetch-on-focus semantics still apply: only stale queries refetch,
 * and per-query opt-outs (e.g. `staleTime: Infinity`) are respected.
 *
 * Call once during app bootstrap.
 */
export function setupFocusManager(): void {
  focusManager.setEventListener((handleFocus) => {
    if (typeof window === 'undefined' || !window.addEventListener) {
      return undefined
    }

    const onFocus = () => handleFocus()

    window.addEventListener('visibilitychange', onFocus, false)
    window.addEventListener('focus', onFocus, false)
    window.addEventListener('pageshow', onFocus, false)

    return () => {
      window.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onFocus)
    }
  })
}
