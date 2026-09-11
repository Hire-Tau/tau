import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db, agents, executions, integrationExportConsents, integrationExportCursors, messages } from '../../../db'
import { projectCompletedExecution, type ProjectableMessage } from './projection'
import { encodeBigbrainSession } from '../bigbrain/export'
import type { ExportOutbox } from './outbox'
import type { IntegrationAuditRecorder } from '../audit'

export class ExportCompletionProjector {
  constructor(
    private readonly outbox: ExportOutbox,
    private readonly audit: IntegrationAuditRecorder
  ) {}
  async handle(executionId: string): Promise<void> {
    const [execution] = await db
      .select({
        id: executions.id,
        agentId: executions.agentId,
        status: executions.status,
        squadId: agents.squadId,
        parentAgentId: agents.parentAgentId,
      })
      .from(executions)
      .innerJoin(agents, eq(agents.id, executions.agentId))
      .where(eq(executions.id, executionId))
      .limit(1)
    if (!execution || execution.status !== 'completed' || !execution.squadId || execution.parentAgentId) return
    const [state] = await db
      .select({ consent: integrationExportConsents, cursor: integrationExportCursors })
      .from(integrationExportConsents)
      .innerJoin(integrationExportCursors, eq(integrationExportCursors.consentId, integrationExportConsents.id))
      .where(and(eq(integrationExportConsents.agentId, execution.agentId), isNull(integrationExportConsents.revokedAt)))
      .limit(1)
    if (!state) return
    // Select only rows attributed server-side to this exact execution. The
    // projector still rejects the whole group if any row has uncertain provenance.
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.agentId, execution.agentId),
          or(
            sql`${messages.metadata}->>'executionId' = ${executionId}`,
            sql`${messages.metadata}->>'streamGroupId' = ${executionId}`
          )
        )
      )
      .orderBy(asc(messages.enqueueOrder))
    const projected = projectCompletedExecution(rows as ProjectableMessage[], {
      agentId: execution.agentId,
      executionId,
      consentingUserId: state.consent.consentedByUserId,
      adoptedEnqueueOrder: state.consent.adoptedEnqueueOrder,
      policyVersion: state.consent.policyVersion,
      projectionVersion: state.consent.projectionVersion,
    })
    if (!projected.included) {
      await this.audit.record({
        connectionId: state.consent.connectionId,
        squadId: execution.squadId,
        agentId: execution.agentId,
        userId: state.consent.consentedByUserId,
        capability: 'conversation_export',
        action: 'project',
        outcome: 'denied',
        code: projected.code,
        at: new Date(),
      })
      return
    }
    const payload = encodeBigbrainSession(projected.records)
    const batch = await this.outbox.enqueue({
      cursor: {
        id: state.cursor.id,
        consentId: state.cursor.consentId,
        lastDeliveredEnqueueOrder: state.cursor.lastDeliveredEnqueueOrder,
      },
      plaintext: payload,
      firstEnqueueOrder: projected.firstOrder,
      lastEnqueueOrder: projected.lastOrder,
      recordCount: projected.records.length,
    })
    if (batch)
      await this.audit.record({
        connectionId: state.consent.connectionId,
        squadId: execution.squadId,
        agentId: execution.agentId,
        userId: state.consent.consentedByUserId,
        capability: 'conversation_export',
        action: 'enqueue',
        outcome: 'succeeded',
        idempotencyKey: batch.idempotencyKey,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        at: new Date(),
      })
  }
}
