import { SandboxProvisionError, type SandboxProvisionContext } from './provision-errors'

export type ProvisionFailureCode =
  | 'control_plane_unavailable'
  | 'control_plane_throttled'
  | 'control_plane_error'
  | 'cluster_authorization'
  | 'unschedulable_capacity'
  | 'invalid_sandbox_image'
  | 'storage_substrate'
  | 'invalid_sandbox_spec'
  | 'sandbox_terminal'
  | 'executor_unready'
  | 'devbox_unready'
  | 'cancelled'
  | 'unknown'

export interface ClassifiedProvisionFailure {
  code: ProvisionFailureCode
  breaker: 'certain' | 'correlated' | 'sandbox' | 'neutral'
  publicMessage: string
}

type FailureInput = {
  code?: unknown
  name?: unknown
  kind?: unknown
  reason?: unknown
  response?: { statusCode?: unknown; status?: unknown }
  statusCode?: unknown
  cause?: unknown
}

const result = (
  code: ProvisionFailureCode,
  breaker: ClassifiedProvisionFailure['breaker'],
  publicMessage: string
): ClassifiedProvisionFailure => ({ code, breaker, publicMessage })

/** Classify raw dependency failures without retaining or reflecting their response bodies. */
export function classifyProvisionFailure(value: unknown): ClassifiedProvisionFailure {
  let current: unknown = value
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const input = current as FailureInput
    const classified = classifyOne(input)
    if (classified) return classified
    current = input.cause
  }
  return result('unknown', 'neutral', 'Sandbox provisioning failed.')
}

function classifyOne(input: FailureInput): ClassifiedProvisionFailure | null {
  if (input.name === 'AbortError' || input.code === 'ABORT_ERR')
    return result('cancelled', 'neutral', 'Sandbox provisioning was cancelled.')

  const networkCode = String(input.code ?? input.name)
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ConnectionRefused'].includes(networkCode))
    return result('control_plane_unavailable', 'certain', 'The Kubernetes control plane is unavailable.')

  const rawStatus =
    input.response?.statusCode ??
    input.response?.status ??
    input.statusCode ??
    (typeof input.code === 'number' ? input.code : undefined)
  const status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus)
  if (status === 408 || status === 429)
    return result('control_plane_throttled', 'certain', 'The Kubernetes control plane is throttling requests.')
  if (status >= 500 && status <= 599)
    return result('control_plane_error', 'certain', 'The Kubernetes control plane returned an error.')
  if (status === 401 || status === 403)
    return result('cluster_authorization', 'certain', 'Kubernetes sandbox provisioning is not authorized.')
  if (status === 400 || status === 409 || status === 422)
    return result('invalid_sandbox_spec', 'sandbox', 'The sandbox specification was rejected.')

  switch (input.kind) {
    case 'unschedulable':
      return result('unschedulable_capacity', 'correlated', 'The cluster cannot currently schedule the sandbox.')
    case 'storage':
      return result('storage_substrate', 'correlated', 'The sandbox storage substrate is not ready.')
    case 'image':
      return result('invalid_sandbox_image', 'sandbox', 'The sandbox image could not be pulled.')
    case 'terminal':
      return result('sandbox_terminal', 'sandbox', 'The sandbox pod terminated before becoming ready.')
    case 'executor':
      return result('executor_unready', 'sandbox', 'The sandbox executor did not become ready.')
    case 'devbox':
      return result('devbox_unready', 'sandbox', 'The sandbox development environment did not become ready.')
    default:
      return null
  }
}

export interface ProvisionRecoveryDisposition {
  provision: SandboxProvisionContext
  errorCode: SandboxProvisionError['code']
  retryAfterMs?: number
}

const RECOVERABLE_REASONS = new Set<ProvisionFailureCode>([
  'control_plane_unavailable',
  'control_plane_throttled',
  'control_plane_error',
  'unschedulable_capacity',
  'storage_substrate',
])

/** Return internal recovery context only for failures that can safely make progress later. */
export function getProvisionRecoveryDisposition(error: unknown): ProvisionRecoveryDisposition | null {
  if (!(error instanceof SandboxProvisionError) || !error.provision) return null

  const reasonCode = error.provision.reasonCode
  if (reasonCode && !RECOVERABLE_REASONS.has(reasonCode)) return null

  const recoverableEnvelope =
    error.code === 'SANDBOX_PROVISION_BUSY' ||
    error.code === 'SANDBOX_PROVISION_COORDINATION_UNAVAILABLE' ||
    error.code === 'SANDBOX_PROVISION_UNAVAILABLE' ||
    (error.code === 'SANDBOX_PROVISION_FAILED' && reasonCode !== undefined)
  if (!recoverableEnvelope) return null

  return { provision: error.provision, errorCode: error.code, retryAfterMs: error.retryAfterMs }
}
