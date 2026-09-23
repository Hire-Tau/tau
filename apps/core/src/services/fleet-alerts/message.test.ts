import { describe, expect, test } from 'bun:test'
import { formatFleetDuration, renderFleetIncidentMessage } from './message'
import type { FleetIncidentNotificationClaim } from './store'

const NOW = new Date('2026-09-23T12:00:00Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const SQUAD_ID = '4ea8b934-a90a-42d1-b6fe-483a2ab9a18b'

function claim(overrides: Partial<FleetIncidentNotificationClaim>): FleetIncidentNotificationClaim {
  return {
    notificationId: 'notification',
    incidentId: 'incident',
    audience: 'human',
    recipientId: null,
    idempotencyKey: null,
    phase: 'alert',
    claimToken: 'token',
    attempts: 0,
    incidentResolvedAt: null,
    incidentStartedAt: ago(45),
    incidentKind: 'squad_dead_fleet',
    squadId: SQUAD_ID,
    scopeKey: `squad:${SQUAD_ID}`,
    causeCode: 'demand-not-served',
    causeSummary:
      '1 pending work item remains; oldest is 4070m old. No execution run has started in the last 45m of pending demand, and no open provider or sandbox incident explains the delay.',
    remediation:
      'Check machine + sandbox health first (`tau machines list`), then worker pickup (`tau worker status`).',
    details: {},
    ...overrides,
  }
}

describe('fleet incident messages', () => {
  test('formats durations in the largest readable units', () => {
    expect(formatFleetDuration(20_000)).toBe('1m')
    expect(formatFleetDuration(45 * 60_000)).toBe('45m')
    expect(formatFleetDuration(190 * 60_000)).toBe('3h 10m')
    expect(formatFleetDuration(120 * 60_000)).toBe('2h')
    expect(formatFleetDuration(4258 * 60_000)).toBe('2d 22h')
  })

  test('a stalled squad is named, with readable waiting time instead of raw minutes', () => {
    const message = renderFleetIncidentMessage(
      claim({ details: { demandCount: 1, oldestDemandAt: ago(4070).toISOString() } }),
      { squadName: 'Tau Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Tau Core stalled')
    expect(message.content).toBe(
      'Work in squad Tau Core has been stalled for 45m.\n\n' +
        'Cause: No agent run has started, and no provider or sandbox problem explains it.\n' +
        'Waiting: 1 work item, the oldest for 2d 19h\n' +
        'Fix: Check machine + sandbox health first (`tau machines list`), then worker pickup (`tau worker status`).'
    )
    expect(message.content).not.toContain(SQUAD_ID)
    expect(message.content).not.toContain('4070m')
    expect(message.push).toEqual({
      title: 'Squad Tau Core stalled',
      body: 'Work in squad Tau Core has been stalled for 45m.',
      subtitle: 'Tau Core',
      collapseKey: 'fleet:incident',
      threadKey: 'fleet',
      interruptionLevel: 'active',
    })
  })

  test('a squad stalled by a provider names the provider', () => {
    const message = renderFleetIncidentMessage(
      claim({
        causeCode: 'plan-credit',
        causeSummary: 'Provider plan credits are unavailable.',
        remediation: undefined,
        details: { demandCount: 2, provider: 'openai-codex' },
      }),
      { squadName: 'Tau Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Tau Core stalled: OpenAI Codex out of plan credits')
    expect(message.content).toContain('Cause: OpenAI Codex plan credits are unavailable.')
    expect(message.content).toContain('Waiting: 2 work items')
  })

  test('a recovery reports how long it lasted and the earlier cause, without remediation', () => {
    const message = renderFleetIncidentMessage(
      claim({ phase: 'recovery', incidentStartedAt: ago(190), incidentResolvedAt: ago(0) }),
      { squadName: 'Tau Core' },
      NOW
    )
    expect(message.subject).toBe('Squad Tau Core is running again')
    expect(message.content).toBe(
      'Work in squad Tau Core is running again after being stalled for 3h 10m.\n\n' +
        'Earlier cause: No agent run has started, and no provider or sandbox problem explains it.'
    )
    expect(message.push.interruptionLevel).toBe('passive')
  })

  test('provider incidents use the provider label and a label-aware cause', () => {
    const base = {
      incidentKind: 'provider_unhealthy' as const,
      squadId: undefined,
      provider: 'openai-codex',
      scopeKey: 'provider:openai-codex:account:*',
      causeCode: 'expired-oauth',
      causeSummary: 'Provider OAuth credentials expired or were revoked.',
      remediation: 'Run `tau pa login openai-codex` to authenticate again.',
    }
    const alert = renderFleetIncidentMessage(claim(base), {}, NOW)
    expect(alert.subject).toBe('OpenAI Codex: sign-in expired')
    expect(alert.content).toBe(
      'Agents that use OpenAI Codex can’t run until this clears.\n\n' +
        'Cause: OpenAI Codex sign-in expired or was revoked.\n' +
        'Started: 45m ago\n' +
        'Fix: Run `tau pa login openai-codex` to authenticate again.'
    )
    expect(alert.push.subtitle).toBeUndefined()
    const recovery = renderFleetIncidentMessage(
      claim({ ...base, phase: 'recovery', incidentResolvedAt: ago(0), incidentStartedAt: ago(125) }),
      {},
      NOW
    )
    expect(recovery.subject).toBe('OpenAI Codex recovered')
    expect(recovery.content).toStartWith('OpenAI Codex is working again after 2h 5m.')
  })

  test('agent sandboxes name the agent and squad and phrase reason codes', () => {
    const agentId = '8feeb6aa-7f95-4686-a92f-56095edd2660'
    const message = renderFleetIncidentMessage(
      claim({
        incidentKind: 'sandbox_degraded',
        squadId: undefined,
        scopeKey: `sandbox:agent_${agentId}`,
        causeCode: 'sandbox-setup-degraded',
        causeSummary: 'VM sandbox best-effort setup remains degraded.',
        remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
        details: {
          sandboxId: `agent_${agentId}`,
          reasons: ['callback_transport_degraded', 'devbox_unavailable', 'future_reason'],
        },
      }),
      { agentName: 'reviewer', squadName: 'Tau Core' },
      NOW
    )
    expect(message.subject).toBe('The sandbox for reviewer in squad Tau Core is degraded')
    expect(message.content).toContain(
      'Cause: VM sandbox setup is degraded: callback connection degraded, devbox unavailable.'
    )
    expect(message.content).not.toContain(agentId)
    expect(message.content).not.toContain('_')
  })

  test('missing names and unknown details fall back without echoing raw details', () => {
    const message = renderFleetIncidentMessage(
      claim({ causeCode: 'unknown-code', causeSummary: 'Sanitized summary.', details: { secret: 'must-not-leak' } }),
      {},
      NOW
    )
    expect(message.subject).toBe('Squad 4ea8b934 stalled')
    expect(message.content).toContain('Cause: Sanitized summary.')
    expect(JSON.stringify(message)).not.toContain('must-not-leak')
    expect(JSON.stringify(message)).not.toContain(SQUAD_ID)
  })
})
