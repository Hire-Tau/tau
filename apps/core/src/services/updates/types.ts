import type { DeploymentFlavor } from './deployment-flavor'

export type UpdateTask = 'install' | 'cli' | 'sandbox' | 'core' | 'web'
export const MANUAL_UPDATE_TARGETS = ['cli', 'sandbox', 'core', 'web'] as const
export type ManualUpdateTarget = (typeof MANUAL_UPDATE_TARGETS)[number]
export type CommandStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type UpdateRunStatus = 'checking' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface PlannedCommand {
  task: UpdateTask
  command: string[]
  status: CommandStatus
  outputTail?: string
  exitCode?: number
  note?: string
}

export interface LocalAutoUpdateSettings {
  enabled: boolean
  intervalMinutes: number
  remote: string
  branch: string
  githubOwner?: string
  githubRepo?: string
  /** Explicit account when more than one GitHub integration connection is available. */
  githubConnectionId?: string
}

export const DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS = {
  enabled: false,
  intervalMinutes: 30,
  remote: 'origin',
  branch: 'main',
} as const satisfies LocalAutoUpdateSettings

export interface LocalUpdateRun {
  id: string
  status: UpdateRunStatus
  mode: 'manual' | 'automatic' | 'check' | 'offline'
  startedAt: string
  completedAt?: string
  beforeSha?: string
  afterSha?: string
  changedFiles: string[]
  selectedTasks: UpdateTask[]
  commands: PlannedCommand[]
  error?: string
  message?: string
  available?: boolean
  dirty?: boolean
  /** True when flavor.sandboxRuntime === 'k3d-local'. */
  localRuntime?: boolean
  flavor?: DeploymentFlavor
  supported?: boolean
  supportReason?: string
  targeted?: boolean
}
