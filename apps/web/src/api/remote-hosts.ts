import { apiFetch } from './client'

/**
 * A remote host as returned by the API (`toPublicRemoteHost`): the full row
 * minus the internal `sshKeyId` secret-store handle. Private key material is
 * never modeled here — it never leaves the server. Dates arrive
 * JSON-serialized as ISO strings.
 */
export interface RemoteHost {
  id: string
  name: string
  description: string | null
  sshHost: string
  sshPort: number
  sshUser: string
  sshPublicKey: string
  createdAt: string
  updatedAt: string
}

/** A remote host plus the squad IDs currently granted access to it (admin/global surface only). */
export interface RemoteHostWithGrants extends RemoteHost {
  squadIds: string[]
}

/** Connectivity-probe result (`POST .../check`). Never throws on an unreachable host. */
export interface RemoteHostCheckResult {
  reachable: boolean
  error?: string
}

/**
 * Result of revoking a squad's grant. Revoking always rotates the host's minted
 * keypair (server `revokeAndRotate`), so the operator must install the new
 * public key on the host afterwards. `rotated:true` carries `sshPublicKey` +
 * install `message`; `rotated:false` carries a `warning` (rotation failed —
 * retry) or a `message` (nothing to rotate, e.g. the host was already deleted).
 */
export interface RevokeRotationResult {
  revoked: boolean
  rotated: boolean
  sshPublicKey?: string
  message?: string
  warning?: string
}

/** Fields shared by both the admin and squad-scoped create routes. */
export interface CreateRemoteHostInput {
  name: string
  sshHost: string
  sshPort?: number
  sshUser: string
  description?: string
}

/** Admin registration additionally accepts initial squad grants. */
export interface CreateRemoteHostAdminInput extends CreateRemoteHostInput {
  squadIds?: string[]
}

/** Result of a squad's ssh-artifact sync push (`POST .../sync`). */
export interface RemoteHostSyncResult {
  pushed: boolean
  reason?: string
}

// ── Global registry surface (admin) ─────────────────────────────────────────

export async function listRemoteHosts(): Promise<RemoteHostWithGrants[]> {
  return apiFetch<RemoteHostWithGrants[]>('/remote-hosts')
}

export async function getRemoteHost(id: string): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}`)
}

export async function createRemoteHost(input: CreateRemoteHostAdminInput): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>('/remote-hosts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteRemoteHost(id: string): Promise<void> {
  await apiFetch(`/remote-hosts/${id}`, { method: 'DELETE' })
}

export async function grantRemoteHost(id: string, squadId: string): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/${id}/grants`, {
    method: 'POST',
    body: JSON.stringify({ squadId }),
  })
}

export async function revokeRemoteHostGrant(id: string, squadId: string): Promise<RevokeRotationResult> {
  return apiFetch<RevokeRotationResult>(`/remote-hosts/${id}/grants/${squadId}`, { method: 'DELETE' })
}

export async function checkRemoteHost(id: string): Promise<RemoteHostCheckResult> {
  return apiFetch<RemoteHostCheckResult>(`/remote-hosts/${id}/check`, { method: 'POST' })
}

// ── Squad surface ────────────────────────────────────────────────────────────

export async function listSquadRemoteHosts(squadId: string): Promise<RemoteHost[]> {
  return apiFetch<RemoteHost[]>(`/remote-hosts/squad/${squadId}`)
}

/** Add-and-grant: registers a new host and grants it to `squadId` in one step. */
export async function addSquadRemoteHost(squadId: string, input: CreateRemoteHostInput): Promise<RemoteHostWithGrants> {
  return apiFetch<RemoteHostWithGrants>(`/remote-hosts/squad/${squadId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Revoke this squad's own grant (never deletes the host row itself). Rotates the host key. */
export async function revokeSquadRemoteHost(squadId: string, hostId: string): Promise<RevokeRotationResult> {
  return apiFetch<RevokeRotationResult>(`/remote-hosts/squad/${squadId}/${hostId}`, { method: 'DELETE' })
}

/** Squad-scoped connectivity probe for a host granted to `squadId`. */
export async function checkSquadRemoteHost(squadId: string, hostId: string): Promise<RemoteHostCheckResult> {
  return apiFetch<RemoteHostCheckResult>(`/remote-hosts/squad/${squadId}/check/${hostId}`, { method: 'POST' })
}

/** Re-push ~/.ssh artifacts to the calling agent's box (agent identities only). */
export async function syncSquadRemoteHosts(squadId: string): Promise<RemoteHostSyncResult> {
  return apiFetch<RemoteHostSyncResult>(`/remote-hosts/squad/${squadId}/sync`, { method: 'POST' })
}
