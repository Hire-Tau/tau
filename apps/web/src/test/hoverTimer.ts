import { spyOn } from 'bun:test'
import { act } from 'react'
import { HOVER_PREVIEW_DELAY_MS } from '../hooks/useThemeHoverPreview'

/** Owns just the hover-intent deadline (HOVER_PREVIEW_DELAY_MS); everything else keeps the real clock. */
export function useHoverTimer() {
  const deadlines = new Map<number, { callback: () => void; ms: number }>()
  let serial = 10000
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === HOVER_PREVIEW_DELAY_MS) {
      deadlines.set(++serial, { callback, ms })
      return serial
    }
    return originalSet(callback, ms, ...(rest as []))
  }) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    if (!deadlines.delete(Number(id))) originalClear(id)
  }) as typeof clearTimeout)
  return {
    advance: (ms: number) =>
      act(async () => {
        for (const [id, deadline] of [...deadlines])
          if (deadline.ms <= ms) {
            deadlines.delete(id)
            deadline.callback()
          }
      }),
    pending: () => deadlines.size,
    restore: () => {
      timer.mockRestore()
      clear.mockRestore()
    },
  }
}
