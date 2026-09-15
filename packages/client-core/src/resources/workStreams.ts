import type { WorkStream } from '@tau/shared'
import type { Transport } from '../transport'
export function workStreamsResource(t: Transport) {
  const path = (id: string) => `/workstreams/${encodeURIComponent(id)}`
  return {
    setAutoCleanupWorktree: (id: string, autoCleanupWorktree: boolean) =>
      t.request<WorkStream>(path(id), { method: 'PATCH', body: { autoCleanupWorktree } }),
    pause: (id: string, options: { reason?: string; parkAfterMinutes?: number | null } = {}) =>
      t.request<WorkStream>(`${path(id)}/pause`, { method: 'POST', body: options }),
    resume: (id: string) => t.request<WorkStream>(`${path(id)}/resume`, { method: 'POST', body: {} }),
    park: (id: string) => t.request<WorkStream>(`${path(id)}/park`, { method: 'POST', body: { preemptRunning: true } }),
  }
}
