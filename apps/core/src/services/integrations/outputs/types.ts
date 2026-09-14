import type { IntegrationOutputDescriptor, IntegrationOutputFact, WorkflowEventTrigger } from '@tau/shared'
import type { VerifiedIngressEvent } from '../types'

export interface IntegrationOutputAdapter {
  integration: string
  catalog: readonly IntegrationOutputDescriptor[]
  /** Bind provider resource details when a squad rule starts work. Actions remain provider independent. */
  workStreamBindings?(fact: IntegrationOutputFact): WorkflowEventTrigger['create']['metadata']
  /** Suppress notification echoes without discarding the recorded provider fact. */
  shouldNotify?(fact: IntegrationOutputFact, connectionConfiguration: unknown): boolean
  normalize(event: VerifiedIngressEvent): IntegrationOutputFact[]
}
/** Supplied by the authenticated ingress, never by event payload or stream metadata. */
export type IntegrationOutputAuthority =
  | { kind: 'instance' }
  | { kind: 'connection'; connectionId: string; squadId: string; connectionRevision?: string }
