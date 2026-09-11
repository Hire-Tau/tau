/**
 * Route guards for the `host` sandbox runtime, where there is no sandbox.
 *
 * HostSandboxManager keeps an in-memory record only: "start" just ensures the
 * squad in this process and "stop" merely forgets that record, so exposing
 * either as a user action lies about what happened. Managed toolchains have
 * nowhere to be provisioned for the same reason. Routes call these guards
 * BEFORE touching the sandbox manager.
 */

import type { Context } from 'hono'
import { isHostRuntime } from '../services/sandbox/runtime'

export const HOST_NO_SANDBOX_ERROR =
  'Not applicable on the host runtime: agents run directly on this machine and there is no sandbox to start or stop.'

export const HOST_NO_TOOLCHAIN_ERROR =
  'Not applicable on the host runtime: managed toolchains are not available when agents run directly on this machine.'

/**
 * Returns a 400 response when the host runtime is active, otherwise null
 * (the caller proceeds) — mirrors the archived-squad guard's shape.
 */
export function hostRuntimeGuard(c: Context, error: string = HOST_NO_SANDBOX_ERROR) {
  return isHostRuntime() ? c.json({ error }, 400) : null
}
