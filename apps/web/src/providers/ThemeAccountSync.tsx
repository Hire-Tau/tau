import { useEffect, useLayoutEffect } from 'react'
import { useAuth } from './AuthProvider'
import { useThemeSyncStore } from './ThemeProvider'
import { client } from '../api/clientInstance'
import type { ThemeSyncApi } from '../theme/sync'

/** Deliberately inside AuthProvider, outside the synchronous paint provider.
 * Two animation frames give the browser a paint opportunity before any theme I/O. */
export function ThemeAccountSync() {
  const { isAuthenticated, authRequired, sessionVersion } = useAuth()
  return (
    <ThemeAccountSyncSession
      sessionKey={authRequired === null ? undefined : isAuthenticated && authRequired ? sessionVersion : null}
    />
  )
}

/** Explicit identity epoch seam for session-boundary regression tests. */
export function ThemeAccountSyncSession({
  sessionKey,
  api = client.userPreferences,
}: {
  sessionKey: number | null | undefined
  api?: ThemeSyncApi
}) {
  const store = useThemeSyncStore()
  useLayoutEffect(() => {
    // Invalidate requests before passive effects or the next account can render.
    // Auth bootstrap (unknown status) leaves the pre-paint cache untouched.
    if (sessionKey !== undefined) store.disconnect(true)
    return () => store.disconnect()
  }, [store, sessionKey, api])
  useEffect(() => {
    if (sessionKey == null) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => store.connect(api))
    })
    const refresh = () => {
      void store.refresh()
    }
    const visible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      cancelAnimationFrame(frame)
      store.disconnect()
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [store, sessionKey, api])
  return null
}
