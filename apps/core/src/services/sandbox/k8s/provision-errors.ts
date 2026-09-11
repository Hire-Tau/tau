import type { ProvisionFailureCode } from './provision-failure'

export type SandboxProvisionErrorCode =
  | 'SANDBOX_PROVISION_UNAVAILABLE'
  | 'SANDBOX_PROVISION_BUSY'
  | 'SANDBOX_PROVISION_FAILED'
  | 'SANDBOX_PROVISION_COORDINATION_UNAVAILABLE'

export interface SandboxProvisionContext {
  scope: string
  sandboxKey: string
  reasonCode?: ProvisionFailureCode
  circuitVersion?: number
  /** Stable for one coordinator invocation; never serialize this context publicly. */
  refusalId: string
}

/** A deliberately sanitized provisioning error suitable for API and worker boundaries. */
export class SandboxProvisionError extends Error {
  constructor(
    public readonly code: SandboxProvisionErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly provision?: SandboxProvisionContext
  ) {
    super(message)
    this.name = 'SandboxProvisionError'
  }
}

/** Sanitized internal failure carrying only classifier context, never a raw Kubernetes error. */
export class K8sProvisionAttemptError extends Error {
  constructor(
    public readonly kind: 'unschedulable' | 'storage' | 'image' | 'terminal' | 'executor',
    message: string
  ) {
    super(message)
    this.name = 'K8sProvisionAttemptError'
  }
}
