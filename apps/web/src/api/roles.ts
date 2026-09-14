import { apiFetch } from './client'

export interface RoleSummary {
  id: string
  name: string
  slug: string
  permissions: string[]
  /**
   * Which kind of subject the role may be granted to. Optional so an older server
   * that doesn't send it is treated as user-assignable (see isUserAssignableRole).
   */
  appliesTo?: 'user' | 'agent' | 'both'
  isSystem?: boolean
  createdAt?: string
  updatedAt?: string
}

/**
 * Whether a role belongs in a HUMAN role picker. Agent roles (default-worker,
 * default-manager, default-manager) are derived from an agent's type and are
 * meaningless on a person, so they never appear in one.
 */
export function isUserAssignableRole(role: RoleSummary): boolean {
  return role.appliesTo !== 'agent'
}

export async function listRoles(): Promise<RoleSummary[]> {
  return apiFetch('/roles')
}

export async function getRole(id: string): Promise<RoleSummary> {
  return apiFetch(`/roles/${id}`)
}

export async function createRole(data: { name: string; slug: string; permissions: string[] }): Promise<RoleSummary> {
  return apiFetch('/roles', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateRole(id: string, data: { name?: string; permissions?: string[] }): Promise<RoleSummary> {
  return apiFetch(`/roles/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function deleteRole(id: string): Promise<void> {
  return apiFetch(`/roles/${id}`, { method: 'DELETE' })
}
