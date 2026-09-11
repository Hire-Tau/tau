import { getSandboxManager } from '../sandbox'

/**
 * The scope within which a local deployment's port must be unique.
 *
 * Docker and k8s give every sandbox its own network namespace: two squads can
 * both bind 3000 and neither notices, which is why that has always been legal.
 * A VM "box" is not a container — it is a systemd unit running as a
 * `box_<hash>` user directly on the machine (services/machines/box-manager.ts),
 * so every box on a machine shares ONE loopback and a port is a machine-wide
 * claim. Two squads asking for 3000 collide there, and a tokenized deployment
 * URL could forward to a different squad's app.
 *
 * Expressing the scope per runtime — rather than enforcing one global rule —
 * is what lets the invariant be correct for VM without invalidating the
 * deployments every docker/k8s instance is already running.
 */
export type LocalDeploymentPortScope = string

/** Falls back to the sandbox scope for any runtime that does not share a host. */
export async function resolveLocalDeploymentPortScope(sandboxId: string): Promise<LocalDeploymentPortScope> {
  const manager = getSandboxManager()
  const machineId = await manager.getSandboxMachineId?.(sandboxId).catch(() => null)
  return machineId ? `machine:${machineId}` : `sandbox:${sandboxId}`
}
