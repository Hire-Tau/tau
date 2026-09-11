import type { IntegrationCapabilityKind } from './types'

/** Deliberately content-free integration audit event. */
export interface IntegrationAuditEvent {
  connectionId?: string
  squadId?: string
  agentId?: string
  userId?: string
  capability?: IntegrationCapabilityKind
  action: string
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed'
  requestId?: string
  idempotencyKey?: string
  recordCount?: number
  byteCount?: number
  code?: string
  at: Date
}

export interface IntegrationAuditRecorder {
  record(event: IntegrationAuditEvent): Promise<void>
}
