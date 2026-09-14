import { apiFetch } from './client'

export interface LinkedChatAccount {
  id: string
  provider: string
  instanceName: string
  externalUserId: string
  externalUserName: string
}
export interface PendingChatLink {
  id: string
  expiresAt: string
  provider: string | null
  instanceName: string | null
  externalUserId: string | null
  externalUserName: string | null
}
export const getChannelLinks = () =>
  apiFetch<{ links: LinkedChatAccount[]; pending: PendingChatLink[] }>('/channel-links')
export const startChannelLink = () =>
  apiFetch<{ id: string; code: string; expiresAt: string }>('/channel-links', { method: 'POST' })
export const confirmChannelLink = (id: string) => apiFetch(`/channel-links/${id}/confirm`, { method: 'POST' })
export const removeChannelLink = (id: string) => apiFetch(`/channel-links/${id}`, { method: 'DELETE' })
