import type { IntegrationAuditRecorder } from '../audit'

export interface ExportConsentRecord {
  id: string
  connectionId: string
  agentId: string
  consentedByUserId: string
  consentedAt: Date
  revokedAt: Date | null
  policyVersion: 1
  projectionVersion: 1
  adoptedEnqueueOrder: bigint
}
export interface EligibleExportAgent {
  id: string
  squadId: string | null
  parentAgentId: string | null
}
export interface ExportConsentRepository {
  activeForAgent(agentId: string): Promise<ExportConsentRecord | null>
  maxEnqueueOrder(agentId: string): Promise<bigint>
  createWithCursor(
    input: Omit<ExportConsentRecord, 'id' | 'consentedAt' | 'revokedAt'> & { squadId: string }
  ): Promise<ExportConsentRecord>
  revoke(agentId: string, at: Date): Promise<ExportConsentRecord | null>
}
export interface ExportConsentGate {
  check(input: { agentId: string; squadId: string; connectionId: string }): Promise<{ allowed: boolean }>
}

export class ExportConsentService {
  constructor(
    private readonly repository: ExportConsentRepository,
    private readonly gate: ExportConsentGate,
    private readonly now = () => new Date(),
    private readonly audit?: IntegrationAuditRecorder
  ) {}
  status(agentId: string): Promise<ExportConsentRecord | null> {
    return this.repository.activeForAgent(agentId)
  }
  async enable(input: {
    agent: EligibleExportAgent
    connectionId: string
    userId: string
    policyVersion: number
    projectionVersion: number
  }): Promise<ExportConsentRecord> {
    if (!input.agent.squadId || input.agent.parentAgentId)
      throw new Error('Conversation is not eligible for external export')
    if (input.policyVersion !== 1 || input.projectionVersion !== 1) throw new Error('Unsupported export policy version')
    if (await this.repository.activeForAgent(input.agent.id)) throw new Error('External export is already enabled')
    if (
      !(
        await this.gate.check({
          agentId: input.agent.id,
          squadId: input.agent.squadId,
          connectionId: input.connectionId,
        })
      ).allowed
    )
      throw new Error('Integration export capability unavailable')
    const adoptedEnqueueOrder = await this.repository.maxEnqueueOrder(input.agent.id)
    const consent = await this.repository.createWithCursor({
      squadId: input.agent.squadId,
      connectionId: input.connectionId,
      agentId: input.agent.id,
      consentedByUserId: input.userId,
      policyVersion: 1,
      projectionVersion: 1,
      adoptedEnqueueOrder,
    })
    await this.audit?.record({
      connectionId: consent.connectionId,
      squadId: input.agent.squadId,
      agentId: input.agent.id,
      userId: input.userId,
      capability: 'conversation_export',
      action: 'consent_enable',
      outcome: 'succeeded',
      at: this.now(),
    })
    return consent
  }
  async revoke(agentId: string, squadId?: string, userId?: string): Promise<ExportConsentRecord | null> {
    const consent = await this.repository.revoke(agentId, this.now())
    if (consent && squadId) {
      await this.audit?.record({
        connectionId: consent.connectionId,
        squadId,
        agentId,
        userId,
        capability: 'conversation_export',
        action: 'consent_revoke',
        outcome: 'succeeded',
        at: this.now(),
      })
    }
    return consent
  }
}
