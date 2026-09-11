import type { Machine } from './queries'

/**
 * Provider abstraction for VM-based sandbox "machines". A provider knows how
 * to provision, terminate, and check the status of the hardware backing a
 * `Machine` row. BYO-SSH machines (registered by hand) and future
 * cloud-provisioned providers (e.g. an "exe" provider) both implement this.
 */

export interface MachineSpec {
  name: string
  scope?: 'shared' | 'dedicated'
  sizeHint?: string
  /**
   * UNUSED as of the exe live-recon reconciliation (2026-07-13): no caller threads
   * a public key anymore. exe.dev authenticates SSH against the ACCOUNT-registered
   * key only (a per-VM key is rejected), so neither the POST /api/machines exe
   * branch nor placement's auto-provision injects one; the exe adapter ignores this
   * field and the BYO-SSH adapter cannot provision at all. Retained (over removal)
   * because callers/tests still pass it through and assert it absent — a future
   * provider that DOES need a per-machine key can wire it back in here.
   */
  publicKey?: string
}

export interface ProvisionedMachine {
  sshHost: string
  sshPort: number
  sshUser: string
  providerRef: string
}

export interface MachineProvider {
  readonly key: string
  provision(spec: MachineSpec): Promise<ProvisionedMachine>
  /** Never destroys user-owned hardware for BYO providers — see ssh adapter. */
  terminate(machine: Machine): Promise<void>
  status(machine: Machine): Promise<'running' | 'parked' | 'gone'>
  park?(machine: Machine): Promise<void>
  resume?(machine: Machine): Promise<void>
}

export class MachineProviderError extends Error {}

/**
 * Shape of the SSH command-execution primitive that Task 3 (`ssh.ts`)
 * implements as `sshExec`. Defined here (rather than in the ssh adapter) so
 * the adapter can accept it as an injected dependency without importing a
 * module that doesn't exist yet, and so Task 3 can implement against this
 * type without depending on `providers/ssh.ts`.
 */
export type MachineExecFn = (
  machine: Machine,
  command: string,
  opts?: { timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// Registry: provider key -> implementation. Populated by adapters calling
// `registerMachineProvider` at wiring time (not at module init, since the
// ssh adapter needs an injected `exec` dependency). This module-level map is
// the sanctioned test seam: tests register fakes here directly.
const registry = new Map<string, MachineProvider>()

export function registerMachineProvider(provider: MachineProvider): void {
  registry.set(provider.key, provider)
}

/**
 * Remove a provider from the registry. Test-support only (production never
 * unregisters): lets a test that registers a fake into the real registry restore
 * the prior state so it does not leak into other tests sharing the process.
 */
export function unregisterMachineProvider(key: string): void {
  registry.delete(key)
}

export function getMachineProvider(key: string): MachineProvider {
  const provider = registry.get(key)
  if (!provider) {
    throw new MachineProviderError(`unknown machine provider: ${key}`)
  }
  return provider
}
