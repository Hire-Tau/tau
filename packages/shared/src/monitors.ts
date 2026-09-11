export type MonitorStatus =
  | 'starting'
  | 'running'
  | 'canceling'
  | 'exited'
  | 'canceled'
  | 'timed-out'
  | 'failed'
  | 'overload'
export interface Monitor {
  id: string
  agentId: string
  sandboxId: string
  label: string
  description: string | null
  command: string
  cwd: string | null
  status: MonitorStatus
  processId: string
  timeoutMs: number
  maxBatchLines: number
  maxBatchBytes: number
  batchDebounceMs: number
  exitCode: number | null
  failureReason: string | null
  failureKind: string | null
  linesEmitted: number
  bytesEmitted: number
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  lastBatchAt: string | null
}

export interface MonitorLogs {
  lines: string[]
  note?: string
}
