import {
  resolveTrackedResources,
  trackedResourceMatches,
  type IntegrationOutputFact,
  type TrackedResourceKind,
} from '@tau/shared'
import { integrationOutputRegistry } from './registry'
import type { integrationOutputEvents } from '../../../db'

type Event = typeof integrationOutputEvents.$inferSelect
export interface TrackedTarget {
  integration: string
  repository: string
  kind: TrackedResourceKind
  number: number
  url?: string
}

export function eventTrackedResource(event: {
  integration: string
  fact: IntegrationOutputFact
}): TrackedTarget | null {
  return integrationOutputRegistry.adapter(event.integration)?.trackedResource?.(event.fact) ?? null
}

/** Correlation only: a match never grants the connection any access. */
export function streamTracksEvent(metadata: unknown, event: Event): boolean {
  const target = eventTrackedResource(event)
  if (!target) return false
  const connectionId = event.authority.kind === 'connection' ? event.authority.connectionId : undefined
  return resolveTrackedResources(metadata).some((resource) =>
    trackedResourceMatches(resource, { ...target, connectionId })
  )
}
