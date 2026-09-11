import { getMachine as getMachineReal } from './queries'
import type { Machine } from './queries'

/**
 * A machine pin was rejected: the target machine does not exist or is not ready.
 * Routes surface this as a 400 (a user-fixable input error), distinct from the
 * infra-level {@link MachineUnavailableError} the placement policy throws at
 * ensure time.
 */
export class MachinePinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachinePinError'
  }
}

/**
 * Validate a machine pin before it is written to an agent/squad row.
 *
 *  - `null` unpins (placement falls back to the shared/policy default on the next
 *    ensure) and is always allowed — no DB read.
 *  - A non-null id MUST reference an existing, `ready` machine; otherwise the pin
 *    would only ever fail (loudly) at ensure time, so reject it up front.
 *
 * `getMachine` is injectable for tests; production reads the real query.
 */
export async function assertMachinePinReady(
  machineId: string | null,
  deps: { getMachine?: (id: string) => Promise<Machine | null> } = {}
): Promise<void> {
  if (machineId == null) return
  const getMachine = deps.getMachine ?? getMachineReal
  const machine = await getMachine(machineId)
  if (!machine) throw new MachinePinError(`machine not found: ${machineId}`)
  if (machine.status !== 'ready') {
    throw new MachinePinError(`machine ${machine.name} is not ready (status ${machine.status})`)
  }
}
