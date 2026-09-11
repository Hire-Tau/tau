import { describe, expect, test } from 'bun:test'
import { HUMAN_FALLBACK_MS, planFleetAlert, planSandboxAlert } from './audience-policy'

const providerCauses = [
  'rate-limit',
  'plan-credit',
  'capacity',
  'error',
  'invalid-credential',
  'expired-oauth',
  'network',
] as const

describe('fleet alert audience policy', () => {
  test('routes every provider cause immediately to humans only', () => {
    for (const causeCode of providerCauses) {
      expect(planFleetAlert({ kind: 'provider_unhealthy', causeCode, hasValidManager: false })).toEqual({
        manager: 'none',
        humanDelayMs: 0,
      })
    }
  })

  test('routes dead-fleet causes manager-first regardless of attribution', () => {
    for (const causeCode of ['expired-oauth', 'sandbox-setup-degraded', 'demand-not-served', 'future-safe-cause']) {
      expect(planFleetAlert({ kind: 'squad_dead_fleet', causeCode, hasValidManager: false })).toEqual({
        manager: 'deliver',
        humanDelayMs: HUMAN_FALLBACK_MS,
      })
    }
  })

  test('delays humans for manager-remediable sandbox reasons', () => {
    for (const reason of ['devbox_unavailable', 'bashrc_unavailable']) {
      expect(planSandboxAlert([reason], true)).toEqual({ manager: 'deliver', humanDelayMs: HUMAN_FALLBACK_MS })
    }
  })

  test('notifies both audiences immediately for human-remediable sandbox reasons', () => {
    for (const reason of [
      'git_credentials_unavailable',
      'transport_recovery_failed',
      'callback_transport_degraded',
      'command_outcome_ambiguous',
    ]) {
      expect(planSandboxAlert([reason], true)).toEqual({ manager: 'deliver', humanDelayMs: 0 })
    }
  })

  test('treats mixed, empty, and unknown sandbox reasons conservatively', () => {
    expect(planSandboxAlert(['devbox_unavailable', 'git_credentials_unavailable'], true)).toEqual({
      manager: 'deliver',
      humanDelayMs: 0,
    })
    expect(planSandboxAlert([], true)).toEqual({ manager: 'deliver', humanDelayMs: 0 })
    expect(planSandboxAlert(['future_reason'], true)).toEqual({ manager: 'deliver', humanDelayMs: 0 })
    expect(planSandboxAlert(['devbox_unavailable', 'future_reason'], true)).toEqual({
      manager: 'deliver',
      humanDelayMs: 0,
    })
  })

  test('skips a missing sandbox manager and escalates immediately', () => {
    expect(planSandboxAlert(['devbox_unavailable'], false)).toEqual({ manager: 'skip', humanDelayMs: 0 })
  })
})
