import type { WorkStreamPriority, WorkStreamStatus } from './types'

/**
 * Work-stream priority math shared by core (admission ordering, manager
 * surfaces) and web (badges). Priority is ADVISORY: nothing here transitions
 * streams — it only orders and annotates them.
 *
 * Effective priority implements classic priority inheritance: a stream's
 * effective priority is the max of its own stored priority and the effective
 * priority of every OPEN stream that depends on it (boost flows UP dependsOn
 * edges onto blockers), so a `low` fix a `high` feature depends on schedules
 * as `high`. Closed streams (done/canceled) contribute nothing.
 */

const PRIORITY_RANK: Record<WorkStreamPriority, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
}

export function priorityRank(priority: WorkStreamPriority): number {
  return PRIORITY_RANK[priority]
}

export function maxPriority(a: WorkStreamPriority, b: WorkStreamPriority): WorkStreamPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b
}

/** The minimal stream surface the effective-priority computation needs. */
export interface PriorityGraphStream {
  id: string
  title: string
  priority: WorkStreamPriority
  status: WorkStreamStatus
  dependsOn: string[]
}

export interface EffectivePriorityEntry {
  effective: WorkStreamPriority
  /**
   * The immediate dependent whose (effective) priority produced the boost, or
   * null when the stored priority already wins. Lets surfaces render
   * `low (effective: high via <dependent title>)`.
   */
  viaId: string | null
}

function isOpen(status: WorkStreamStatus): boolean {
  return status !== 'done' && status !== 'canceled'
}

/**
 * Compute effective priorities for a squad's streams. Pure; DAG assumed (cycle
 * rejection is enforced at write time), but a visited set guards traversal so
 * malformed data degrades to stored priorities instead of hanging.
 */
export function computeEffectivePriorities(streams: PriorityGraphStream[]): Map<string, EffectivePriorityEntry> {
  const byId = new Map(streams.map((s) => [s.id, s]))
  // dependents.get(x) = open streams whose dependsOn contains x
  const dependents = new Map<string, PriorityGraphStream[]>()
  for (const s of streams) {
    if (!isOpen(s.status)) continue
    for (const dep of s.dependsOn) {
      if (!byId.has(dep)) continue
      const list = dependents.get(dep)
      if (list) list.push(s)
      else dependents.set(dep, [s])
    }
  }

  const memo = new Map<string, EffectivePriorityEntry>()

  function effectiveOf(id: string, visiting: Set<string>): EffectivePriorityEntry {
    const cached = memo.get(id)
    if (cached) return cached
    const self = byId.get(id)
    if (!self) return { effective: 'normal', viaId: null }
    if (visiting.has(id)) return { effective: self.priority, viaId: null }
    visiting.add(id)

    let effective = self.priority
    let viaId: string | null = null
    for (const dependent of dependents.get(id) ?? []) {
      const dependentEntry = effectiveOf(dependent.id, visiting)
      if (priorityRank(dependentEntry.effective) > priorityRank(effective)) {
        effective = dependentEntry.effective
        viaId = dependent.id
      }
    }

    visiting.delete(id)
    const entry: EffectivePriorityEntry = { effective, viaId }
    memo.set(id, entry)
    return entry
  }

  const result = new Map<string, EffectivePriorityEntry>()
  for (const s of streams) {
    result.set(s.id, effectiveOf(s.id, new Set()))
  }
  return result
}

/**
 * Admission order: highest effective priority first, ties broken by createdAt
 * (oldest first), then id for total determinism. Callers must pass entries
 * with the effective priority already resolved.
 */
export function compareByEffectivePriorityThenCreatedAt(
  a: { id: string; effective: WorkStreamPriority; createdAt: Date },
  b: { id: string; effective: WorkStreamPriority; createdAt: Date }
): number {
  const rankDiff = priorityRank(b.effective) - priorityRank(a.effective)
  if (rankDiff !== 0) return rankDiff
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime()
  if (timeDiff !== 0) return timeDiff
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
