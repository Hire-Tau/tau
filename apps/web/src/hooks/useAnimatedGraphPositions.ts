import { useEffect, useState } from 'react'
import { useStableRef } from './useStableRef'

type Positions = Record<string, { x: number; y: number }>

/** Interpolate one shared set of coordinates so cards, handles and arrows move together. */
export function useAnimatedGraphPositions(target: Positions, enabled: boolean): Positions {
  const [frame, setFrame] = useState<Positions>(target)
  const rendered = useStableRef(enabled ? frame : target)
  const key = JSON.stringify(target)
  useEffect(() => {
    const next: Positions = JSON.parse(key)
    if (
      !enabled ||
      typeof requestAnimationFrame === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setFrame(next)
      return
    }
    const start = rendered.current
    let startTime: number | undefined
    let handle: number
    const tick = (time: number) => {
      startTime ??= time
      const progress = Math.min(1, (time - startTime) / 280)
      const eased = 1 - (1 - progress) ** 3
      setFrame(
        Object.fromEntries(
          Object.entries(next).map(([id, end]) => {
            const from = start[id] ?? end
            return [id, { x: from.x + (end.x - from.x) * eased, y: from.y + (end.y - from.y) * eased }]
          })
        )
      )
      if (progress < 1) handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [key, enabled, rendered])
  return enabled ? frame : target
}
