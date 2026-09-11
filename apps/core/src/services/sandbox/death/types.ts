import type { SandboxRuntime } from '../types'

export type SandboxDeathSignal = 'failed' | 'evicted' | 'succeeded' | 'not_found' | 'exited'

export type TerminationIntentReason = 'idle' | 'manual' | 'shutdown' | 'squad-removed'

export type SandboxDeathClassification = 'unexpected' | 'oom' | 'intentional' | 'ignored'

/**
 * Which runtime a death was observed on. Widened from the original
 * `'k8s' | 'docker'` (which predated the vm/host runtimes) to the shared
 * closed set, so vm/host deaths are representable. `'docker'` stays as a
 * legacy coarse label emitted by existing producers — new producers should
 * emit their exact runtime.
 */
export type SandboxDeathRuntime = SandboxRuntime | 'docker'

export interface SandboxDeathObservation {
  sandboxId: string
  signal: SandboxDeathSignal
  reason?: string
  message?: string
  exitCode?: number
  memoryLimit?: string
  runtime: SandboxDeathRuntime
  startedAt?: string
}
