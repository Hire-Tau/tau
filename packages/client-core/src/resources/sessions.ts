import type { Transport } from '../transport'

export interface SessionSummary {
  id: string
  userAgent?: string | null
  ipAddress?: string | null
  createdAt: string
  expiresAt: string
}

export function sessionsResource(t: Transport) {
  return {
    listSessions: (): Promise<SessionSummary[]> => t.request('/sessions'),
    revokeSession: (id: string): Promise<void> => t.request(`/sessions/${id}`, { method: 'DELETE' }),
    revokeAllSessions: (): Promise<void> => t.request('/sessions', { method: 'DELETE' }),
  }
}
