import { describe, expect, test } from 'bun:test'
import { isAutomatedReviewGate } from './automated-review-gate'

const metadata = {
  completion: { mode: 'pr-auto-merge' },
  codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 7 } },
}
const derived = {
  delivery: { kind: 'external' },
  openWaits: [{ type: 'review', closedAt: null }] as const,
}

describe('isAutomatedReviewGate', () => {
  test('true for an open review wait settling through an authorized auto-merge delivery', () => {
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata }, derived, true)).toBe(true)
  })

  test('false without an open review wait', () => {
    expect(
      isAutomatedReviewGate(
        { squadId: 'squad', metadata },
        { delivery: { kind: 'external' }, openWaits: [{ type: 'question', closedAt: null }] },
        true
      )
    ).toBe(false)
    expect(
      isAutomatedReviewGate(
        { squadId: 'squad', metadata },
        { delivery: { kind: 'external' }, openWaits: [{ type: 'review', closedAt: '2026-09-24T00:00:00Z' }] },
        true
      )
    ).toBe(false)
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata }, undefined, true)).toBe(false)
  })

  test('false while the delivery still needs a human, is broken, or has no delivery fact', () => {
    for (const kind of ['merge', 'approval', 'review', 'setup', 'failure'] as const) {
      expect(
        isAutomatedReviewGate(
          { squadId: 'squad', metadata },
          { delivery: { kind }, openWaits: derived.openWaits },
          true
        )
      ).toBe(false)
    }
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata }, { openWaits: derived.openWaits }, true)).toBe(false)
  })

  test('false without the squad auto-merge policy: delivery then leaves the PR for a human merge', () => {
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata }, derived, undefined)).toBe(false)
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata }, derived, false)).toBe(false)
  })

  test('false for pr-merge and direct-merge completions even while the code host works', () => {
    expect(
      isAutomatedReviewGate(
        { squadId: 'squad', metadata: { ...metadata, completion: { mode: 'pr-merge' } } },
        derived,
        true
      )
    ).toBe(false)
    expect(
      isAutomatedReviewGate(
        { squadId: 'squad', metadata: { ...metadata, completion: { mode: 'direct-merge' } } },
        derived,
        true
      )
    ).toBe(false)
  })

  test('requires a tracked change request; the legacy github metadata shape resolves too', () => {
    const noChangeRequest = {
      completion: { mode: 'pr-auto-merge' },
      codeHost: { integration: 'github', repository: 'acme/widgets' },
    }
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata: noChangeRequest }, derived, true)).toBe(false)
    const legacyGithub = {
      completion: { mode: 'pr-auto-merge' },
      github: { repo: 'acme/widgets', pr: { number: 7 } },
    }
    expect(isAutomatedReviewGate({ squadId: 'squad', metadata: legacyGithub }, derived, true)).toBe(true)
  })
})
