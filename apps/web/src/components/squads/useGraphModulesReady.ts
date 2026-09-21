import { useEffect, useState } from 'react'

/** Readiness is React state, not the current value of a mutable module binding.
 * Imports may finish after mount but BEFORE the user selects 3D. Awaiting the
 * shared promise in either case also guarantees that both 3D modules are loaded.
 */
export function useGraphModulesReady(enabled: boolean, modulesReady: Promise<unknown>): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    void modulesReady.then(() => {
      if (!disposed) setReady(true)
    })
    return () => {
      disposed = true
    }
  }, [enabled, modulesReady])
  return ready
}
