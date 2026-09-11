import { useEffect, useState } from 'react'

/**
 * Returns Date.now() and re-renders every `intervalMs` while enabled.
 */
export function useTick(intervalMs: number = 1000, enabled: boolean = true): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])

  return now
}
