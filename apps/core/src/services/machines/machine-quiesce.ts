// Fence EVERY box on one machine at once, so the machine itself can be taken
// down safely — the quiescence half of the platform's NATIVE machine-host
// resize (docs/history/superpowers/specs/2026-08-09-dual-resize-paths-design.md).
//
// WHY THIS REUSES THE MIGRATION FENCE RATHER THAN INVENTING A SECOND MODEL:
// a native DigitalOcean resize powers the droplet OFF. Every box on it dies
// instantly — mid-turn, mid-write, with no chance to settle. That is precisely
// the hazard `machine_boxes.migrating` already exists for: a box migration also
// tears a box down out from under whatever is running on it, and the fence is
// how the system refuses to do that while a turn is live. So this module builds
// on the SAME primitives (queries.ts's fenceBoxForMigration / clearBoxMigrating)
// and the SAME activity probe (box-migrate.ts's sandboxActivity) rather than
// asking a second question about what "busy" means.
//
// Inheriting sandboxActivity verbatim also inherits its deliberate asymmetries,
// which must NOT be re-litigated here:
//   - a SQUAD box counts only `running`/`stopping` executions. `queued` is NOT
//     counted, and that is proven safe rather than sloppy: pickup's start guard
//     takes the same `machine_boxes` row FOR UPDATE inside its claim
//     transaction, so once the fence commits `migrating = true` no queued row
//     can reach 'running'. Counting queued would only turn a busy squad — or
//     one wedged queued row — into a permanent refusal.
//   - an AGENT / system-manager box counts `queued`/`waiting-sandbox` too, via
//     ownerActivity's recursive walk over subagent descendants.
//
// ALL-OR-NOTHING. If any single box refuses, every fence this call already took
// is released before returning. A partial quiesce is worse than none: it would
// leave some boxes fenced (their turns deferred indefinitely) while the caller
// correctly declines to power anything off.
//
// NOT crash-durable, by inheritance. `migrating` is cleared wholesale at core
// API boot (queries.ts's recoverMigrationFencesOnce) precisely because a fence
// can only ever be held by a live in-process call. A core API restart WHILE a
// machine is powered off for a resize therefore drops these fences early. That
// is an accepted limitation, not an oversight: the boxes on a powered-off
// machine are unreachable anyway, so a turn that starts against one fails on
// its own rather than corrupting anything — the fence is buying a clean
// refusal, not durability. The same caveat already applies to an in-flight
// migrateBox and is documented on clearAllMigratingFences.

import { createLogger } from '../../lib/infra/logger'
import { db } from '../../db'
import { sandboxActivity } from './box-migrate'
import { clearBoxMigrating, fenceBoxForMigration, listMachineBoxes, type DbTransaction } from './queries'

const log = createLogger('machine-quiesce')

/** One box this call could NOT fence, and why — `activeExecutionCount` is null when the probe could not derive one. */
export interface QuiesceRefusal {
  sandboxId: string
  activeExecutionCount: number | null
}

export interface QuiesceMachineResult {
  /** Sandbox ids this call now EXCLUSIVELY holds the fence for. Empty whenever `refused` is non-empty (all-or-nothing). */
  quiesced: string[]
  /**
   * Unordered exact set of boxes that refused, keyed by `sandboxId`.
   * Non-empty means nothing was left fenced.
   */
  refused: QuiesceRefusal[]
}

export interface QuiesceOptions {
  owner?: string
  /**
   * Operator override for the ACTIVE-EXECUTION refusal ONLY — the same escape
   * migrateBox offers, with the same posture: it is logged at WARN naming the
   * bypassed execution count, and it bypasses nothing else (a box already
   * fenced by a concurrent migration still refuses, because re-winning another
   * caller's fence would let two teardowns run against one box).
   *
   * Forcing means powering off a machine with live turns on it. Those turns die
   * with the droplet and their in-flight writes are lost — exactly as they are
   * for a forced migration.
   */
  force?: { actor: string; reason: string }
}

export interface QuiesceDeps {
  listBoxes: typeof listMachineBoxes
  fence: typeof fenceBoxForMigration
  clearFence: typeof clearBoxMigrating
  activity: typeof sandboxActivity
}

const defaultDeps: QuiesceDeps = {
  listBoxes: listMachineBoxes,
  fence: fenceBoxForMigration,
  clearFence: clearBoxMigrating,
  activity: sandboxActivity,
}

/**
 * Claim the migration fence for every box currently on `machineId`.
 *
 * A machine with no boxes quiesces trivially (`{quiesced: [], refused: []}`) —
 * that is a SUCCESS, and callers must distinguish it from the refusal case by
 * `refused.length`, never by `quiesced.length`.
 */
export async function quiesceMachineBoxes(
  machineId: string,
  opts: QuiesceOptions = {},
  deps: Partial<QuiesceDeps> = {}
): Promise<QuiesceMachineResult> {
  const d = { ...defaultDeps, ...deps }
  const boxes = await d.listBoxes(machineId)

  const quiesced: string[] = []
  const refused: QuiesceRefusal[] = []

  for (const box of boxes) {
    // Captured by the probe below on the way past, so a refusal can report HOW
    // busy the box was instead of a bare "no".
    let observedCount: number | null = null
    const probe = async (sandboxId: string, tx?: DbTransaction): Promise<boolean> => {
      // `tx` is the fence's OWN transaction handle — sandboxActivity must run
      // inside it (see fenceBoxForMigration's contract: the probe holds the box
      // row lock, so it must be one indexed query on the same connection).
      const activity = tx ? await d.activity(sandboxId, tx) : await d.activity(sandboxId)
      observedCount = activity.activeExecutionCount ?? null
      if (!opts.force) return activity.active
      if (activity.active) {
        log.warn(
          `quiesce ${sandboxId} (machine ${machineId}): forced by ${opts.force.actor} past ` +
            `${activity.activeExecutionCount ?? 'an unknown number of'} active execution(s) — reason: ${opts.force.reason}`
        )
      }
      // Force suppresses the ACTIVE-EXECUTION refusal only; fenceBoxForMigration
      // still loses to a fence another caller already holds.
      return false
    }

    const fenced = await d.fence(box.sandboxId, probe, db, opts.owner)
    if (fenced) quiesced.push(box.sandboxId)
    else refused.push({ sandboxId: box.sandboxId, activeExecutionCount: observedCount })
  }

  if (refused.length > 0) {
    // All-or-nothing — see this module's header. Release is best-effort per box:
    // one clear failing must not prevent the others, and the refusal is the
    // story the caller needs regardless.
    await releaseMachineBoxes(quiesced, deps, opts.owner)
    return { quiesced: [], refused }
  }

  return { quiesced, refused: [] }
}

/**
 * Lift the fences a prior {@link quiesceMachineBoxes} took. Takes the EXPLICIT
 * sandbox id list that call returned rather than re-deriving "every box on the
 * machine", so this can never clear a fence belonging to a concurrent
 * migrateBox of some box that arrived on the machine in between.
 *
 * Best-effort per box (a failed clear is logged and the rest still run):
 * callers invoke this from a `finally`, where throwing would replace the real
 * failure with a cleanup failure. Returns how many were cleared.
 */
export async function releaseMachineBoxes(
  sandboxIds: string[],
  deps: Partial<QuiesceDeps> = {},
  owner?: string
): Promise<number> {
  const d = { ...defaultDeps, ...deps }
  let released = 0
  for (const sandboxId of sandboxIds) {
    try {
      await d.clearFence(sandboxId, owner)
      released += 1
    } catch (err) {
      log.error(`quiesce release: clearing the fence on ${sandboxId} failed — it will clear at the next API boot`, err)
    }
  }
  return released
}
