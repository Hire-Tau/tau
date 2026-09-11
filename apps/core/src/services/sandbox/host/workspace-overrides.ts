/**
 * Host runtime: per-squad workspace override cache (squads.host_workspace_path).
 *
 * Workspace layouts are synchronous and resolved from ids alone at many call
 * sites (tools, prompts, routes), so the override cannot be a DB read at
 * layout time. This leaf module holds the current table in memory; it is
 * hydrated at boot (workspace-overrides-hydrate.ts), refreshed from the Squad
 * row inside the ensure flow, and set directly by the squad PATCH route in the
 * API process. A worker sees a PATCH at the squad's next ensure.
 *
 * Pure leaf: no DB or factory imports (workspace-layout depends on it).
 */

const overrides = new Map<string, string>()

export function getHostWorkspaceOverride(squadId: string): string | undefined {
  return overrides.get(squadId)
}

export function setHostWorkspaceOverride(squadId: string, path: string | null): void {
  if (path === null) overrides.delete(squadId)
  else overrides.set(squadId, path)
}

export function replaceHostWorkspaceOverrides(entries: ReadonlyArray<{ squadId: string; path: string }>): void {
  overrides.clear()
  for (const { squadId, path } of entries) overrides.set(squadId, path)
}

export function clearHostWorkspaceOverrides(): void {
  overrides.clear()
}
