import type { ServerInfo } from '@tau/shared'
import type { Transport } from '../transport'

export interface AuthStatus {
  /** Absent on servers predating capability discovery. */
  server?: ServerInfo
  authEnabled: boolean
  mode: 'password' | 'passkey'
  hasUsers: boolean
  hasAdminUser: boolean
  emailConfigured: boolean
  /**
   * Whether registration could succeed for SOME address a stranger types — the only
   * signup-policy signal exposed anonymously (the allowed-domain list stays behind
   * GET /auth/settings). False on an invite-only instance with no allowed domains,
   * where offering "Create account" only leads to a 403.
   */
  canSelfRegister: boolean
}

export type AuthIdentity =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string; squadId: string | null; userId?: string }
  | { type: 'legacy' }
  | { type: 'system'; systemTokenId: string; name: string; scopes: string[] }

export interface AuthUser {
  id: string
  email: string
  displayName?: string | null
  disabledAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface AuthSettings {
  allowedDomains: string[]
  requireInvite: boolean
  /** Null or absent means self-registered accounts receive no role. */
  defaultSignupRoleId?: string | null
}

export interface VerificationResult {
  ok: boolean
  firstUser?: boolean
  emailConfigured?: boolean
  code?: string
}

export type DevicePlatform = 'ios' | 'android' | 'cli'

export interface DeviceAuthorizationPreview {
  name: string
  platform: DevicePlatform
  expiresAt: string
}

/** Result of claiming a QR pairing code from a mobile device. */
export interface PairClaimResult {
  token: string
  deviceId: string
  user: AuthUser
}

/** A paired mobile device (self-service view). */
export interface DeviceSummary {
  id: string
  name: string
  platform: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** Cross-platform auth surface. Browser-only WebAuthn ceremonies stay in apps/web/src/api/auth.ts. */
export function authResource(t: Transport) {
  return {
    getAuthStatus: (): Promise<AuthStatus> => t.request('/auth/status'),
    loginWithPassword: (password: string): Promise<{ ok: boolean }> =>
      t.request('/auth/login', { method: 'POST', body: { password } }),
    sendVerificationEmail: (email: string): Promise<VerificationResult> =>
      t.request('/auth/register/email', { method: 'POST', body: { email } }),
    getAuthSettings: (): Promise<AuthSettings> => t.request('/auth/settings'),
    updateAuthSettings: (settings: Partial<AuthSettings>): Promise<AuthSettings> =>
      t.request('/auth/settings', { method: 'PUT', body: settings }),
    validateAuth: (): Promise<{ valid: boolean }> => t.request('/auth/validate'),
    /** Mint a single-use, short-lived ticket for authenticating a WebSocket connection. */
    fetchWsTicket: (): Promise<{ ticket: string }> => t.request('/auth/ws-ticket', { method: 'POST' }),
    getCurrentUser: (): Promise<AuthUser> => t.request('/auth/me'),
    updateCurrentUser: (input: { displayName?: string }): Promise<AuthUser> =>
      t.request('/auth/me', { method: 'PATCH', body: input }),
    getMyPermissions: (squadId?: string): Promise<{ permissions: string[]; identity: AuthIdentity }> => {
      const query = squadId ? `?${new URLSearchParams({ squadId })}` : ''
      return t.request(`/auth/permissions${query}`)
    },

    // ── Device pairing (QR) ──────────────────────────────────────────────────
    /** (web, authenticated) Start a pairing: returns a short-lived code + the server URL to encode in a QR. */
    pairStart: (): Promise<{ code: string; serverUrl: string; expiresAt: string }> =>
      t.request('/auth/pair/start', { method: 'POST' }),
    /** (mobile, unauthenticated) Claim a scanned code → a long-lived per-device token. */
    pairClaim: (input: { code: string; name: string; platform: DevicePlatform }): Promise<PairClaimResult> =>
      t.request('/auth/pair/claim', { method: 'POST', body: input }),
    deviceAuthorizationInspect: (input: { verificationCode: string }): Promise<DeviceAuthorizationPreview> =>
      t.request('/auth/device/inspect', { method: 'POST', body: input }),
    deviceAuthorizationApprove: (input: { verificationCode: string }): Promise<{ ok: true }> =>
      t.request('/auth/device/approve', { method: 'POST', body: input }),
    /** (self-service) List my paired devices. */
    listDevices: (): Promise<DeviceSummary[]> => t.request('/auth/devices'),
    /** (self-service) Revoke one of my paired devices. */
    revokeDevice: (id: string): Promise<void> => t.request(`/auth/devices/${id}`, { method: 'DELETE' }),
  }
}
