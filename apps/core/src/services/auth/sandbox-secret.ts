import { randomBytes } from 'crypto'
import { getSecretStore } from '../secrets'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('sandbox-secret')

/**
 * Ensure SANDBOX_CALLBACK_SECRET exists, generating + persisting one on first
 * boot. It authenticates the in-cluster sandbox watcher's core callbacks
 * (workspace-files) and is injected into sandbox pods by the sandbox managers.
 */
export async function ensureSandboxCallbackSecret(): Promise<void> {
  const store = getSecretStore()
  if (store.get('SANDBOX_CALLBACK_SECRET')) return
  try {
    await store.set('SANDBOX_CALLBACK_SECRET', randomBytes(32).toString('hex'), 'system')
    log.info('Generated SANDBOX_CALLBACK_SECRET')
  } catch (err) {
    // No encryption key configured (read-only env-fallback mode): the operator
    // must supply SANDBOX_CALLBACK_SECRET via env, otherwise sandbox workspace-file
    // indexing stays unauthenticated/unavailable until one is provided.
    log.warn(`Could not persist SANDBOX_CALLBACK_SECRET: ${(err as Error).message}`)
  }
}
