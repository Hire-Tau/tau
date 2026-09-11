import { desc, eq, sql } from 'drizzle-orm'
import { boxCondemnationEvidence, db } from '../../db'

export type BoxLivenessClassification = 'exited' | 'machine_unreachable' | 'running_http_dead'

export type BoxHealthProbeKind = 'http_status' | 'refused' | 'reset' | 'abort_timeout' | 'other'

export interface BoxHealthProbeEvidence {
  observedAt: Date
  /** Machine-actionable failure category; never collapse transport failures to a boolean. */
  kind: BoxHealthProbeKind
  /** Wall-clock duration of this individual attempt. */
  elapsedMs: number
  status?: number
  error?: string
}

export interface BoxMachineSnapshot {
  observedAt: Date
  /**
   * What the HOST says about the box's units.
   *  - `running` — its socket is up and a server process is serving (or the
   *    box is still on the pre-socket layout and its service is up).
   *  - `idle` — socket up, no server process. HEALTHY: the next connection
   *    re-activates the chain. This is the steady state of a socket-activated
   *    box that nobody is talking to, and the whole point of spec D2.
   *  - `exited` — no socket, or a server unit that has genuinely `failed`.
   *    The only value that means the box is down.
   */
  liveness?: 'running' | 'idle' | 'exited'
  containerStates?: string
  logTail?: string
  error?: string
}

export interface BoxCondemnationEvidenceInput {
  sandboxId: string
  machineId: string
  classification: BoxLivenessClassification
  probes: BoxHealthProbeEvidence[]
  machineSnapshot: BoxMachineSnapshot
  activeExecution: boolean | null
  graceBudgetMs: number
  recordedAt: Date
}

const BOX_EVIDENCE_LOCK_NAMESPACE = 1_844_920_017

/** Persist a monotonically-generated condemnation record before box mutation. */
export async function persistBoxCondemnationEvidence(input: BoxCondemnationEvidenceInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOX_EVIDENCE_LOCK_NAMESPACE}, hashtext(${input.sandboxId}))`)
    const [latest] = await tx
      .select({ generation: boxCondemnationEvidence.generation })
      .from(boxCondemnationEvidence)
      .where(eq(boxCondemnationEvidence.sandboxId, input.sandboxId))
      .orderBy(desc(boxCondemnationEvidence.generation))
      .limit(1)
    await tx.insert(boxCondemnationEvidence).values({
      ...input,
      generation: (latest?.generation ?? 0) + 1,
    })
  })
}
