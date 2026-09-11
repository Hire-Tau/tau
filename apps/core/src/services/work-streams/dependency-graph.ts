/**
 * Work-stream dependency (dependsOn) cycle rejection.
 *
 * Every write that adds dependsOn edges must keep the squad's dependency graph
 * a DAG (the effective-priority computation and admission eligibility both
 * assume it). Creation cannot form a cycle — a brand-new stream id has no
 * incoming edges — so enforcement happens on updates.
 */

export class DependencyCycleError extends Error {
  /** The cycle, as stream titles, starting and ending at the origin stream. */
  readonly path: string[]

  constructor(path: string[]) {
    super(`dependsOn would create a cycle: ${path.join(' → ')}`)
    this.name = 'DependencyCycleError'
    this.path = path
  }
}

export interface DependencyGraphStream {
  id: string
  title: string
  dependsOn: string[]
}

/**
 * Throws {@link DependencyCycleError} when replacing `originId`'s dependsOn
 * with `nextDependsOn` would make `originId` reachable from itself. Unknown
 * ids (e.g. cross-squad dependencies not present in `streams`) are treated as
 * leaves — they cannot point back into this graph's origin.
 */
export function assertNoDependencyCycle(
  streams: DependencyGraphStream[],
  originId: string,
  nextDependsOn: string[]
): void {
  const byId = new Map(streams.map((s) => [s.id, s]))
  const titleOf = (id: string): string => byId.get(id)?.title ?? id.slice(0, 8)
  const edgesOf = (id: string): string[] => (id === originId ? nextDependsOn : (byId.get(id)?.dependsOn ?? []))

  // DFS from the origin following dependsOn edges; a path back to the origin
  // is a cycle. Self-edges fall out of the same walk (origin → origin).
  const stack: { id: string; path: string[] }[] = [{ id: originId, path: [originId] }]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const { id, path } = stack.pop()!
    for (const dep of edgesOf(id)) {
      if (dep === originId) {
        throw new DependencyCycleError([...path, dep].map(titleOf))
      }
      if (visited.has(dep) || !byId.has(dep)) continue
      visited.add(dep)
      stack.push({ id: dep, path: [...path, dep] })
    }
  }
}
