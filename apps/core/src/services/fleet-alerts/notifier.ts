import { SYSTEM_RECIPIENT_ID } from '@tau/shared'
import { InboxMessage } from '../../entities/InboxMessage'
import {
  bindFleetIncidentManagerTarget,
  claimDueFleetIncidentNotifications,
  markFleetIncidentNotificationDelivered,
  retryFleetIncidentNotification,
  type FleetIncidentNotificationClaim,
} from './store'

export interface FleetIncidentNotifierAdapter {
  /** Test-only crash seam after durable sendOnce and before token-gated settlement. */
  afterSendOnce?: (input: { claim: FleetIncidentNotificationClaim; inboxMessageId: string }) => Promise<void>
}

export class FleetIncidentNotifier {
  constructor(private readonly adapter: FleetIncidentNotifierAdapter = {}) {}

  claimDue(input: {
    now: Date
    limit?: number
    incidentIds?: readonly string[]
  }): Promise<FleetIncidentNotificationClaim[]> {
    return claimDueFleetIncidentNotifications(input)
  }

  markDelivered(input: {
    notificationId: string
    claimToken: string
    inboxMessageId: string
    now: Date
  }): Promise<boolean> {
    return markFleetIncidentNotificationDelivered(input)
  }

  async drain(input: { now: Date; limit?: number; incidentIds?: readonly string[] }): Promise<void> {
    const claims = await this.claimDue(input)
    await Promise.all(claims.map((claim) => this.deliver(claim, input.now)))
  }

  private async deliver(claim: FleetIncidentNotificationClaim, now: Date): Promise<void> {
    let message: InboxMessage
    try {
      const target =
        claim.audience === 'manager'
          ? await bindFleetIncidentManagerTarget(claim)
          : {
              recipientId: claim.recipientId ?? SYSTEM_RECIPIENT_ID,
              idempotencyKey: claim.idempotencyKey ?? `fleet-incident:${claim.incidentId}:${claim.phase}:human:system`,
            }
      const input = this.messageInput(claim, target.recipientId)
      const existing = await InboxMessage.findByIdempotencyKey(target.idempotencyKey)
      message = existing ?? (await InboxMessage.sendOnce(input, target.idempotencyKey)).message
      this.assertDurableWinner(message, claim, target.recipientId)
    } catch {
      await retryFleetIncidentNotification({ claim, now })
      return
    }

    // This intentional crash seam remains outside ordinary failure handling so
    // an expired lease can adopt the already-created durable inbox winner.
    await this.adapter.afterSendOnce?.({ claim, inboxMessageId: message.id })
    await this.markDelivered({
      notificationId: claim.notificationId,
      claimToken: claim.claimToken,
      inboxMessageId: message.id,
      now,
    })
  }

  private messageInput(claim: FleetIncidentNotificationClaim, recipientId: string) {
    const scope =
      claim.incidentKind === 'sandbox_degraded'
        ? claim.scopeKey.replace(/^sandbox:/, 'sandbox ')
        : claim.squadId
          ? `squad ${claim.squadId}`
          : `provider ${claim.provider ?? 'unknown'}`
    const phase = claim.phase === 'alert' ? 'alert' : 'recovery'
    const subject = `Fleet ${phase}: ${scope}`
    const remediation = claim.remediation ? `\n\nRemediation: ${claim.remediation}` : ''
    const managerInstruction =
      claim.audience === 'manager' && claim.phase === 'alert'
        ? '\n\nDiagnose this incident, attempt safe recovery or rerouting, and escalate only when credentials, approval, billing, or other external/operator action is required.'
        : ''
    const content =
      `${claim.phase === 'alert' ? 'A fleet incident requires attention.' : 'A fleet incident has recovered.'}\n\n` +
      `Scope: ${scope}\n` +
      `Cause: ${claim.causeSummary}${remediation}${managerInstruction}`

    if (claim.audience === 'manager') {
      return {
        recipientType: 'agent' as const,
        recipientId,
        senderType: 'system' as const,
        deliveryMode: 'steer' as const,
        wakeEligible: true,
        subject,
        content,
        metadata: {
          source: 'fleet-incident-manager',
          audience: 'manager',
          incidentId: claim.incidentId,
          incidentKind: claim.incidentKind,
          phase: claim.phase,
          squadId: claim.squadId,
        },
      }
    }
    return {
      recipientType: 'system' as const,
      recipientId: SYSTEM_RECIPIENT_ID,
      senderType: 'system' as const,
      wakeEligible: false,
      subject,
      content,
      metadata: {
        source: 'fleet-alert',
        audience: 'human',
        incidentId: claim.incidentId,
        incidentKind: claim.incidentKind,
        phase: claim.phase,
        squadId: claim.squadId,
        provider: claim.provider,
      },
    }
  }

  private assertDurableWinner(message: InboxMessage, claim: FleetIncidentNotificationClaim, recipientId: string): void {
    const metadata = message.metadata
    const expectedSource = claim.audience === 'manager' ? 'fleet-incident-manager' : 'fleet-alert'
    const legacyHuman = claim.audience === 'human' && metadata.audience == null
    if (
      message.recipientType !== (claim.audience === 'manager' ? 'agent' : 'system') ||
      message.recipientId !== recipientId ||
      message.senderType !== 'system' ||
      metadata.source !== expectedSource ||
      metadata.incidentId !== claim.incidentId ||
      metadata.phase !== claim.phase ||
      (claim.audience === 'manager' && metadata.wakeEligible !== true) ||
      (!legacyHuman && metadata.audience !== claim.audience)
    ) {
      throw new Error('Fleet inbox idempotency key belongs to a different delivery')
    }
  }
}
