export const PLATFORM_MAINTENANCE_PROTOCOL_VERSION = 1
export const PLATFORM_MAINTENANCE_HEADERS = {
  protocol: 'x-tau-maintenance-protocol',
  callerVersion: 'x-tau-caller-version',
  instanceId: 'x-tau-instance-id',
  correlationId: 'x-tau-correlation-id',
} as const

export interface PlatformMaintenanceCompatibilityContext {
  protocolVersion: number | null
  callerVersion: string | null
  instanceId: string | null
  correlationId: string | null
}
