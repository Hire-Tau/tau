import { useCallback, useEffect, useRef } from 'react'
import { getApiUrl } from '../../api/client'

export type RestartPhase = 'idle' | 'needs-restart' | 'restarting' | 'waiting-down' | 'waiting-up'

/**
 * Pure transition for the restart reconnect poll. `healthy` is `res.ok` from a
 * /health probe — false on ANY non-ok response OR a thrown fetch.
 *
 * The load-bearing case is `('waiting-down', healthy=false) → 'waiting-up'`.
 * Behind a reverse proxy (caddy on systemd deploys) a dead API answers a **502**
 * — `fetch` RESOLVES with `res.ok === false`, it does NOT throw. Treating only a
 * thrown fetch as "down" (the old bug) left the UI stuck on "Shutting down…"
 * forever behind a proxy; it only worked in local dev, where a dead API is
 * connection-refused (a throw). Collapsing both to `healthy = res.ok` fixes it.
 */
export function nextRestartState(
  current: 'waiting-down' | 'waiting-up',
  healthy: boolean
): 'waiting-down' | 'waiting-up' | 'idle' {
  if (current === 'waiting-down') return healthy ? 'waiting-down' : 'waiting-up'
  return healthy ? 'idle' : 'waiting-up'
}

/**
 * Probe /health, returning true only on a genuine 2xx. Any non-ok response
 * (incl. a reverse proxy's 502/503/504 for a dead upstream — which `fetch`
 * RESOLVES, does not throw) OR a thrown fetch (connection-refused in local dev)
 * counts as down. This uniform treatment is the fix: the old code only reacted
 * to throws, so behind caddy it never detected the server going down.
 */
export async function probeHealthy(healthUrl: string): Promise<boolean> {
  try {
    // no-store: a cached 200 must not mask a server that is actually down.
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * While a restart is in flight, polls /health and advances
 * `waiting-down → waiting-up → idle` so the UI reconnects on its own instead of
 * spinning until a manual page refresh. Shared by every settings restart flow.
 */
export function useRestartPolling(
  restartState: RestartPhase,
  setRestartState: (s: 'waiting-up' | 'idle') => void,
  pollIntervalMs = 2000
) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    if (restartState !== 'waiting-down' && restartState !== 'waiting-up') {
      cleanup()
      return
    }

    const healthUrl = getApiUrl('/health')

    intervalRef.current = setInterval(async () => {
      const healthy = await probeHealthy(healthUrl)
      const next = nextRestartState(restartState, healthy)
      if (next !== restartState) setRestartState(next as 'waiting-up' | 'idle')
    }, pollIntervalMs)

    return cleanup
  }, [restartState, setRestartState, cleanup, pollIntervalMs])
}
