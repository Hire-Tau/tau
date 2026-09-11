export const PLATFORM_UPDATE_STATUSES = [
  'checking',
  'checked',
  'queued',
  'staging',
  'preflighting',
  'draining',
  'activating',
  'verifying',
  'rolling_back',
  'succeeded',
  'failed',
  'rolled_back',
] as const

export type PlatformUpdateStatus = (typeof PLATFORM_UPDATE_STATUSES)[number]

export const TENANT_UPGRADE_SCOPES = ['none', 'all', 'selected'] as const
export type TenantUpgradeScope = (typeof TENANT_UPGRADE_SCOPES)[number]

export const PLATFORM_UPDATE_FORWARD_ONLY_SCHEMA_WARNING =
  'Staged verification can apply forward-only database migrations before activation. Code rollback does not reverse schema. The target must keep migrations backward-compatible with the retained rollback release.'

export const PLATFORM_UPDATE_STATUS_META = {
  checking: { active: false, terminal: false, blocksJobClaims: false, label: 'Checking repository' },
  checked: { active: false, terminal: true, blocksJobClaims: false, label: 'Checked' },
  queued: { active: true, terminal: false, blocksJobClaims: false, label: 'Starting' },
  staging: { active: true, terminal: false, blocksJobClaims: false, label: 'Building release' },
  preflighting: {
    active: true,
    terminal: false,
    blocksJobClaims: false,
    label: 'Running artifact and schema preflight',
  },
  draining: { active: true, terminal: false, blocksJobClaims: true, label: 'Waiting for in-flight jobs' },
  activating: { active: true, terminal: false, blocksJobClaims: true, label: 'Restarting control plane' },
  verifying: { active: true, terminal: false, blocksJobClaims: true, label: 'Verifying running service' },
  rolling_back: { active: true, terminal: false, blocksJobClaims: true, label: 'Restoring prior release' },
  succeeded: { active: false, terminal: true, blocksJobClaims: false, label: 'Update succeeded' },
  failed: { active: false, terminal: true, blocksJobClaims: false, label: 'Update failed' },
  rolled_back: { active: false, terminal: true, blocksJobClaims: false, label: 'Rolled back' },
} as const satisfies Record<
  PlatformUpdateStatus,
  { active: boolean; terminal: boolean; blocksJobClaims: boolean; label: string }
>

function statusesWhere(predicate: (status: PlatformUpdateStatus) => boolean): PlatformUpdateStatus[] {
  return PLATFORM_UPDATE_STATUSES.filter(predicate)
}

export const ACTIVE_PLATFORM_UPDATE_STATUSES = statusesWhere((status) => PLATFORM_UPDATE_STATUS_META[status].active)
export const PLATFORM_UPDATE_CLAIM_BLOCKING_STATUSES = statusesWhere(
  (status) => PLATFORM_UPDATE_STATUS_META[status].blocksJobClaims
)

export function isActivePlatformUpdateStatus(status: PlatformUpdateStatus): boolean {
  return PLATFORM_UPDATE_STATUS_META[status].active
}

export function isTerminalPlatformUpdateStatus(status: PlatformUpdateStatus): boolean {
  return PLATFORM_UPDATE_STATUS_META[status].terminal
}

export function platformUpdateBlocksJobClaims(status: PlatformUpdateStatus): boolean {
  return PLATFORM_UPDATE_STATUS_META[status].blocksJobClaims
}

export function assertPlatformUpdateStatus(value: unknown): PlatformUpdateStatus {
  if (typeof value === 'string' && (PLATFORM_UPDATE_STATUSES as readonly string[]).includes(value)) {
    return value as PlatformUpdateStatus
  }
  throw new TypeError(`Invalid platform update status: ${String(value)}`)
}

export function assertTenantUpgradeScope(value: unknown): TenantUpgradeScope {
  if (typeof value === 'string' && (TENANT_UPGRADE_SCOPES as readonly string[]).includes(value)) {
    return value as TenantUpgradeScope
  }
  throw new TypeError(`Invalid tenant upgrade scope: ${String(value)}`)
}
