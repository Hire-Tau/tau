import { SandboxProvisionError } from '../services/sandbox/k8s/provision-errors'

export function getSandboxProvisionErrorResponse(error: unknown): {
  status: 503
  retryAfter?: string
  body: { error: string; code: string; retryAfterMs?: number }
} | null {
  if (!(error instanceof SandboxProvisionError)) return null
  const retryAfter = error.retryAfterMs == null ? undefined : String(Math.ceil(error.retryAfterMs / 1_000))
  return {
    status: 503,
    retryAfter,
    body: { error: error.message, code: error.code, retryAfterMs: error.retryAfterMs },
  }
}
