import { and, desc, eq, isNull, max } from 'drizzle-orm'
import {
  agents,
  db,
  integrationConnectionAssignments,
  integrationExportConsents,
  integrationExportCursors,
  messages,
  squads,
} from '../../../db'
import type { ExportConsentRecord, ExportConsentRepository } from './consent-service'

export class DbExportConsentRepository implements ExportConsentRepository {
  constructor(private readonly hooks: { afterSquadLock?: () => Promise<void> } = {}) {}
  async activeForAgent(agentId: string): Promise<ExportConsentRecord | null> {
    const [row] = await db
      .select()
      .from(integrationExportConsents)
      .where(and(eq(integrationExportConsents.agentId, agentId), isNull(integrationExportConsents.revokedAt)))
      .orderBy(desc(integrationExportConsents.consentedAt))
      .limit(1)
    return row ? map(row) : null
  }
  async maxEnqueueOrder(agentId: string): Promise<bigint> {
    const [row] = await db
      .select({ value: max(messages.enqueueOrder) })
      .from(messages)
      .where(eq(messages.agentId, agentId))
    return row?.value ?? 0n
  }
  async createWithCursor(
    input: Omit<ExportConsentRecord, 'id' | 'consentedAt' | 'revokedAt'> & { squadId: string }
  ): Promise<ExportConsentRecord> {
    return db.transaction(async (tx) => {
      const [lockedSquad] = await tx
        .select({ id: squads.id })
        .from(squads)
        .where(eq(squads.id, input.squadId))
        .for('update')
      if (!lockedSquad) throw new Error('Integration assignment changed')
      await this.hooks.afterSquadLock?.()

      const [eligible] = await tx
        .select({ connectionId: integrationConnectionAssignments.connectionId })
        .from(agents)
        .innerJoin(
          integrationConnectionAssignments,
          and(
            eq(integrationConnectionAssignments.squadId, agents.squadId),
            eq(integrationConnectionAssignments.connectionId, input.connectionId)
          )
        )
        .where(and(eq(agents.id, input.agentId), eq(agents.squadId, input.squadId)))
        .limit(1)
      if (!eligible) throw new Error('Integration assignment changed')

      const [active] = await tx
        .select({ id: integrationExportConsents.id })
        .from(integrationExportConsents)
        .where(and(eq(integrationExportConsents.agentId, input.agentId), isNull(integrationExportConsents.revokedAt)))
        .limit(1)
      if (active) throw new Error('External export is already enabled')

      const { squadId: _squadId, ...values } = input
      const [consent] = await tx.insert(integrationExportConsents).values(values).returning()
      await tx
        .insert(integrationExportCursors)
        .values({ consentId: consent.id, lastDeliveredEnqueueOrder: input.adoptedEnqueueOrder })
      return map(consent)
    })
  }
  async revoke(agentId: string, at: Date): Promise<ExportConsentRecord | null> {
    const [row] = await db
      .update(integrationExportConsents)
      .set({ revokedAt: at })
      .where(and(eq(integrationExportConsents.agentId, agentId), isNull(integrationExportConsents.revokedAt)))
      .returning()
    return row ? map(row) : null
  }
}
function map(row: typeof integrationExportConsents.$inferSelect): ExportConsentRecord {
  return { ...row, policyVersion: 1, projectionVersion: 1 }
}
