import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { AuthStatus } from '../api/auth'
import { apiUrl, authFetch, clearStoredToken, getApiHost } from '../api/client'

interface AuthContextValue {
  /** Changes at every explicit session boundary, even when already signed in. */
  sessionVersion: number
  /** null = still loading, true = auth required, false = auth disabled */
  authRequired: boolean | null
  isAuthenticated: boolean
  /**
   * True while the instance has no users at all — i.e. no admin exists and the app
   * shell is unusable. This wins over `isAuthenticated`: the bootstrap instance
   * password is a valid identity, so without this flag a page refresh during
   * first-run setup lands the visitor in an adminless shell instead of the funnel.
   */
  needsFirstAdminSetup: boolean
  authStatus: AuthStatus | null
  login: (password: string) => Promise<void>
  /**
   * For passkey flow — marks user as authenticated after the passkey component
   * stores the token. `isFirstRegistration` navigates to `/onboarding` once —
   * set ONLY by the bootstrap PasskeyRegister success path (LoginPage.tsx's
   * first-admin funnel). Ordinary logins and the invite/self-register flow
   * omit it, so they never redirect (design §3's "subsequent logins/refreshes
   * do NOT force-redirect").
   */
  loginWithToken: (isFirstRegistration?: boolean) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [sessionVersion, setSessionVersion] = useState(0)
  const [authRequired, setAuthRequired] = useState<boolean | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)

  const forceLogout = useCallback(() => {
    setSessionVersion((v) => v + 1)
    clearStoredToken()
    // Drop all cached query data so the next user can't read the prior user's
    // cached permissions / users / roles on a shared device.
    queryClient.clear()
    setIsAuthenticated(false)
    setAuthRequired(true)
  }, [queryClient])

  /** Re-reads /auth/status. Returns false when the refresh failed (prior status kept). */
  const refreshAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/auth/status'), { credentials: 'include' })
      if (!res.ok) return false
      setAuthStatus((await res.json()) as AuthStatus)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch(apiUrl('/auth/status'), { credentials: 'include' })
        const status = (await res.json()) as AuthStatus
        setAuthStatus(status)

        if (!status.authEnabled) {
          setAuthRequired(false)
          setIsAuthenticated(true)
          return
        }

        setAuthRequired(true)

        // Purge any pre-cookie token left in localStorage (auth is now an HttpOnly
        // cookie sent automatically with credentials), then validate via the cookie.
        clearStoredToken()
        const validateRes = await authFetch('/auth/validate')
        if (validateRes.ok) {
          setIsAuthenticated(true)
        }
      } catch {
        // Fail closed: if auth status cannot be determined, require login rather
        // than exposing the authenticated shell + any cached data.
        setAuthRequired(true)
        setIsAuthenticated(false)
      }
    })()
  }, [])

  // Global 401 interceptor — force logout when any same-host API call returns 401.
  useEffect(() => {
    if (!isAuthenticated) return

    const originalFetch = window.fetch
    const interceptedFetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await originalFetch.apply(window, args)
      if (res.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : ''
        const host = getApiHost()
        if (url.includes('/api/') && (!host || url.includes(host))) {
          forceLogout()
        }
      }
      return res
    }) as typeof fetch
    window.fetch = interceptedFetch
    return () => {
      window.fetch = originalFetch
    }
  }, [forceLogout, isAuthenticated])

  const login = useCallback(
    async (password: string) => {
      // X-Tau-Csrf: the CSRF middleware rejects any cookie-bearing mutation
      // without it. Browser cookies ignore ports, so a stale tau_session from
      // another tau instance on the same host (localhost:3000 next to
      // localhost:3200) rides along with this request and, without the header,
      // turned every password login into a 403 the page reported as
      // "Invalid password".
      const res = await fetch(apiUrl('/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tau-Csrf': '1' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        // Surface the server's reason (e.g. "Password auth disabled. Use
        // passkey login.") instead of flattening every failure to one string.
        let message = 'Invalid password'
        try {
          const body = (await res.json()) as { error?: unknown }
          if (typeof body.error === 'string' && body.error.trim()) message = body.error
        } catch {
          /* non-JSON body: keep the default */
        }
        throw new Error(message)
      }
      queryClient.clear()
      setSessionVersion((v) => v + 1)
      setIsAuthenticated(true)
    },
    [queryClient]
  )

  const loginWithToken = useCallback(
    async (isFirstRegistration = false) => {
      setSessionVersion((v) => v + 1)
      setIsAuthenticated(false)
      queryClient.clear()
      // Re-read the status: registering the first admin flips hasUsers, and the
      // first-admin funnel below keys off it — a stale `hasUsers: false` would loop
      // the freshly created admin back into setup. If the refresh itself fails, fall
      // back to the fact this call already proves: a user now exists.
      const refreshed = await refreshAuthStatus()
      if (!refreshed) {
        setAuthStatus((prev) => (prev ? { ...prev, hasUsers: true } : prev))
      }
      setIsAuthenticated(true)
      if (isFirstRegistration) {
        navigate('/onboarding', { replace: true })
      }
    },
    [queryClient, refreshAuthStatus, navigate]
  )

  const logout = useCallback(async () => {
    setSessionVersion((v) => v + 1)
    setIsAuthenticated(false)
    try {
      await authFetch('/auth/logout', { method: 'POST' })
    } catch {
      // Best effort: local logout must still succeed if the request fails.
    }
    clearStoredToken()
    queryClient.clear()
    setIsAuthenticated(false)
  }, [queryClient])

  // No users means no admin (the first user is auto-promoted), so the instance is
  // unusable until one is created. Auth-disabled instances never funnel.
  const needsFirstAdminSetup = authRequired === true && authStatus !== null && !authStatus.hasUsers

  return (
    <AuthContext.Provider
      value={{
        sessionVersion,
        authRequired,
        isAuthenticated,
        needsFirstAdminSetup,
        authStatus,
        login,
        loginWithToken,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
