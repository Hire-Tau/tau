import { apiFetch } from './client'

export interface SystemToken {
  id: string
  name: string
  scopes: string[]
  kind: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface CreatedSystemToken extends SystemToken {
  /** The raw token — returned only once, at creation. */
  token: string
}

export async function getSystemTokens(includeWebhook = false): Promise<SystemToken[]> {
  return apiFetch<SystemToken[]>(`/system-tokens${includeWebhook ? '?includeWebhook=true' : ''}`)
}

export async function createSystemToken(input: { name: string; scopes: string[] }): Promise<CreatedSystemToken> {
  return apiFetch<CreatedSystemToken>('/system-tokens', { method: 'POST', body: JSON.stringify(input) })
}

export async function revokeSystemToken(id: string): Promise<void> {
  await apiFetch(`/system-tokens/${id}`, { method: 'DELETE' })
}
