import { and, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../../../db'
import { squads } from '../../../db/schema'
import { replaceHostWorkspaceOverrides } from './workspace-overrides'

/** Boot-time fill of the host workspace override cache. Returns the row count. */
export async function hydrateHostWorkspaceOverrides(): Promise<number> {
  const rows = await db
    .select({ squadId: squads.id, path: squads.hostWorkspacePath })
    .from(squads)
    .where(and(isNotNull(squads.hostWorkspacePath), isNull(squads.archivedAt)))
  replaceHostWorkspaceOverrides(rows.filter((r): r is { squadId: string; path: string } => r.path !== null))
  return rows.length
}
