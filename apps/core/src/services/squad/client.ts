import { Squad } from '../../entities/Squad'
import { isRemoteSandboxRuntime, getSandboxManager } from '../sandbox/factory'
import type { K8sSandboxManager, SandboxClient } from '../sandbox/k8s'
export async function getSquadClient(squadId: string): Promise<SandboxClient | null> {
  // Both remote runtimes (k8s + vm) expose a cached SandboxClient via getClient.
  if (!isRemoteSandboxRuntime()) return null
  const sandboxId = Squad.getSandboxId(squadId)
  const manager = getSandboxManager() as K8sSandboxManager

  // If cached, return immediately (client is ready even if devbox isn't)
  const cached = manager.getClient(sandboxId)
  if (cached) return cached

  // Await the manager's bounded shared ensure instead of retaining one polling timer per request.
  const { ensureSquadSandbox } = await import('../sandbox/ensure')
  const ensure = ensureSquadSandbox(squadId)
  const clientReady = manager.waitForClientReady?.(sandboxId)
  if (clientReady) return Promise.race([clientReady, ensure.then(() => manager.getClient(sandboxId))])
  await ensure
  return manager.getClient(sandboxId)
}
