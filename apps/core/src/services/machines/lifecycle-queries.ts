import { inArray } from 'drizzle-orm'
import { db, machineBoxes } from '../../db'
import type { MachineBox } from './queries'

/**
 * Lifecycle-facing queries for VM-based sandbox "boxes".
 *
 * Kept separate from the frozen `queries.ts` (slice 1-3 surface): the slice-4
 * lifecycle loop is DB-driven — after a Core restart the manager's in-memory
 * sandbox map is empty, so the reaper/reconciler must enumerate boxes from the
 * database rather than from process state.
 */

/**
 * Every box across every machine, in a single query. Unlike
 * {@link listMachineBoxes} (machine-scoped), this returns the whole
 * `machine_boxes` table so the lifecycle loop can build one idle/reconcile pass
 * over all boxes regardless of which machine hosts them.
 */
export async function listAllMachineBoxes(): Promise<MachineBox[]> {
  return db.select().from(machineBoxes)
}

/**
 * Stamp the liveness watermark for every box whose port the lifecycle tick just
 * saw LISTENING on its machine.
 *
 * ONE statement for the whole tick: the sweep already learned every listening
 * box from one `ss -ltnH` per machine, and issuing a write per box would undo
 * that saving. The watermark is what lets the API process answer a status poll
 * without an HTTP probe — under socket activation a probe WAKES the box's
 * server, so a polled page would keep every box resident (see boxChainHealth's
 * LISTENING_FRESH_MS short-circuit).
 *
 * No-ops on empty input: an unqualified `IN ()` is a syntax error, and an
 * unbounded UPDATE would stamp boxes nothing was seen listening on.
 */
export async function stampBoxesListening(sandboxIds: string[], at: Date): Promise<void> {
  if (sandboxIds.length === 0) return
  await db.update(machineBoxes).set({ lastListeningAt: at }).where(inArray(machineBoxes.sandboxId, sandboxIds))
}
