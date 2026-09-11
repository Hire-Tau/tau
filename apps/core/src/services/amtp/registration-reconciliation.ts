import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { agents, db } from '../../db'

export interface ReconciledAmtpRegistration {
  id: string
  handle: string
}

/** Close and unpublish impossible historical keyless registrations, retaining handles. */
export async function reconcileKeylessAmtpRegistrations(): Promise<ReconciledAmtpRegistration[]> {
  const rows = await db
    .update(agents)
    .set({ inboundOpen: false, cardJson: null })
    .where(
      and(
        isNotNull(agents.amtpHandle),
        isNull(agents.identityPublicKey),
        or(eq(agents.inboundOpen, true), isNotNull(agents.cardJson))
      )
    )
    .returning({ id: agents.id, handle: agents.amtpHandle })
  return rows.map(({ id, handle }) => ({ id, handle: handle! }))
}
