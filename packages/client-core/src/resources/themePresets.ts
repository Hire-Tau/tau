import type { ThemePreset } from '@tau/shared'
import type { Transport } from '../transport'

export function themePresetsResource(t: Transport) {
  const path = (id: string) => `/theme-presets/${encodeURIComponent(id)}`
  return {
    list: (signal?: AbortSignal) => t.request<ThemePreset[]>('/theme-presets', { signal }),
    get: (id: string, signal?: AbortSignal) => t.request<ThemePreset>(path(id), { signal }),
    create: (document: unknown, signal?: AbortSignal) =>
      t.request<ThemePreset>('/theme-presets', { method: 'POST', body: { document }, signal }),
    update: (id: string, revision: number, document: unknown, signal?: AbortSignal) =>
      t.request<ThemePreset>(path(id), { method: 'PUT', body: { revision, document }, signal }),
    delete: (id: string, revision: number, signal?: AbortSignal) =>
      t.request<{ ok: true }>(path(id), { method: 'DELETE', body: { revision }, signal }),
  }
}
