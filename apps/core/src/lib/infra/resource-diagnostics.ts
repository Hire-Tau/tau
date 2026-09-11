export type ResourceKind = 'sandbox_log_stream' | 'pod_log_transport' | 'port_forward'
export type ResourceOutcome = 'completed' | 'cancelled' | 'failed'

export interface ResourceLease {
  finish(outcome: ResourceOutcome): void
}

interface ResourceCounters {
  active: number
  started: number
  completed: number
  cancelled: number
  failed: number
}

const RESOURCE_KINDS: ResourceKind[] = ['sandbox_log_stream', 'pod_log_transport', 'port_forward']

function emptyCounters(): ResourceCounters {
  return { active: 0, started: 0, completed: 0, cancelled: 0, failed: 0 }
}

export class ResourceDiagnostics {
  private readonly counters = new Map<ResourceKind, ResourceCounters>(
    RESOURCE_KINDS.map((kind) => [kind, emptyCounters()])
  )

  begin(kind: ResourceKind): ResourceLease {
    const counters = this.counters.get(kind)!
    counters.active++
    counters.started++
    let finished = false

    return {
      finish: (outcome) => {
        if (finished) return
        finished = true
        counters.active--
        counters[outcome]++
      },
    }
  }

  snapshot(): Record<ResourceKind, ResourceCounters> {
    return Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, { ...this.counters.get(kind)! }])) as Record<
      ResourceKind,
      ResourceCounters
    >
  }
}

export const resourceDiagnostics = new ResourceDiagnostics()
