import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, remoteHostGrants, remoteHosts, squads } from '../../db'

/**
 * Query layer for the remote-hosts registry (team-owned SSH targets) and
 * their per-squad grants.
 */

export type RemoteHost = typeof remoteHosts.$inferSelect
export type RemoteHostGrant = typeof remoteHostGrants.$inferSelect

export async function insertRemoteHost(values: typeof remoteHosts.$inferInsert): Promise<RemoteHost> {
  const [row] = await db.insert(remoteHosts).values(values).returning()
  return row
}

/**
 * Persist a rotated public key on a host row (grant-revocation rotation,
 * spec §7 of docs/history/superpowers/specs/2026-07-31-machines-backlog-wave-design.md).
 * Only `sshPublicKey` changes — `sshKeyId` is intentionally stable, because
 * the private key is re-minted in place under the same secret-store handle;
 * `updatedAt` is bumped so the rotation is observable.
 */
export async function updateRemoteHostPublicKey(id: string, sshPublicKey: string): Promise<void> {
  await db.update(remoteHosts).set({ sshPublicKey, updatedAt: new Date() }).where(eq(remoteHosts.id, id))
}

export async function getRemoteHost(id: string): Promise<RemoteHost | null> {
  const [row] = await db.select().from(remoteHosts).where(eq(remoteHosts.id, id)).limit(1)
  return row ?? null
}

export async function getRemoteHostByName(name: string): Promise<RemoteHost | null> {
  const [row] = await db.select().from(remoteHosts).where(eq(remoteHosts.name, name)).limit(1)
  return row ?? null
}

export async function listRemoteHosts(): Promise<RemoteHost[]> {
  return db.select().from(remoteHosts)
}

/**
 * Cheap existence check — a bounded `LIMIT 1` probe rather than a full row
 * fetch. Use this instead of `(await listRemoteHosts()).length > 0` on any
 * hot/cheap-lookup path (e.g. status/banner endpoints).
 */
export async function remoteHostsExist(): Promise<boolean> {
  const rows = await db.select({ id: remoteHosts.id }).from(remoteHosts).limit(1)
  return rows.length > 0
}

/**
 * Delete a remote host. Its grants cascade off the `host_id` FK
 * (`ON DELETE cascade`) — no separate grant cleanup needed here.
 */
export async function deleteRemoteHost(id: string): Promise<void> {
  await db.delete(remoteHosts).where(eq(remoteHosts.id, id))
}

export async function listGrantsForHost(hostId: string): Promise<RemoteHostGrant[]> {
  return db.select().from(remoteHostGrants).where(eq(remoteHostGrants.hostId, hostId))
}

/** Squad IDs granted access to a given host. */
export async function listSquadIdsGrantedHost(hostId: string): Promise<string[]> {
  const rows = await db
    .select({ squadId: remoteHostGrants.squadId })
    .from(remoteHostGrants)
    .where(eq(remoteHostGrants.hostId, hostId))
  return rows.map((r) => r.squadId)
}

/**
 * Hosts a given squad has been granted access to, ordered by name so that
 * consumers rendering a deterministic byte-for-byte output (the
 * `remote-hosts/materialize.ts` managed ssh_config block) don't depend on
 * unspecified row order.
 */
export async function listHostsGrantedToSquad(squadId: string): Promise<RemoteHost[]> {
  const rows = await db
    .select({ host: remoteHosts })
    .from(remoteHostGrants)
    .innerJoin(remoteHosts, eq(remoteHosts.id, remoteHostGrants.hostId))
    .where(eq(remoteHostGrants.squadId, squadId))
    .orderBy(asc(remoteHosts.name))
  return rows.map((r) => r.host)
}

export async function insertGrant(values: typeof remoteHostGrants.$inferInsert): Promise<RemoteHostGrant> {
  const [row] = await db.insert(remoteHostGrants).values(values).returning()
  return row
}

export async function deleteGrant(hostId: string, squadId: string): Promise<void> {
  await db
    .delete(remoteHostGrants)
    .where(and(eq(remoteHostGrants.hostId, hostId), eq(remoteHostGrants.squadId, squadId)))
}

/**
 * Non-archived squad IDs that currently have at least one remote-host
 * grant. The boot-time SSH-config backfill (`remote-hosts/backfill.ts`)
 * uses this to re-materialize exactly the squads whose granted aliases
 * should resolve, and nothing else.
 *
 * The join casts squads.id (uuid) to text rather than squad_id to uuid:
 * squad_id is plain text by design (machines.squadId idiom) and is NOT
 * always a UUID, so a uuid cast would hard-fail mid-scan on any legacy
 * row. text-vs-text excludes grants with no live squad row equally well.
 */
export async function listSquadIdsWithGrants(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ squadId: remoteHostGrants.squadId })
    .from(remoteHostGrants)
    .innerJoin(squads, sql`${squads.id}::text = ${remoteHostGrants.squadId}`)
    .where(isNull(squads.archivedAt))
  return rows.map((r) => r.squadId)
}
