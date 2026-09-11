export {
  hasPermission,
  hasUserPermissionWithExecutor,
  hasAnyPermission,
  hasAnySlotCleanupPermission,
  getUserIdsWithPermission,
  resolvePermissions,
  resolveActingUser,
  resolveRoleSummaries,
  getAccessibleSquadIds,
  permissionMatches,
  type Identity,
  type UserIdentity,
  type AgentIdentity,
  type LegacyIdentity,
  type SystemIdentity,
  type ResolvedRoleSummary,
} from './permissions'
export { cacheAgentToken, getCachedAgentToken, removeCachedAgentToken } from './token-cache'
export { auditActor } from './audit-actor'
export {
  hasAgentResourcePermission,
  identityUserId,
  isUserlessAgentIdentity,
  type AgentResourceTarget,
} from './agent-resource-access'
export {
  isEmptyScope,
  narrowScope,
  resolvePermissionSquadScope,
  scopeAllows,
  scopeFromUserRoleRows,
  type PermissionSquadScope,
} from './permission-scope'
