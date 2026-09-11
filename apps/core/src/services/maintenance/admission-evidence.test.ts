import { describe, expect, test } from 'bun:test'
import {
  admissionLeasePauseEvidence,
  authoritativePauseEvidence,
  MaintenanceAdmissionPaused,
  type MaintenancePauseEvidence,
  type RunnerPauseOrigin,
} from './admission-evidence'
import type { AdmissionLease } from './admission-reservation'
import type { MaintenanceSnapshot } from './types'

const snapshot = (input: Partial<MaintenanceSnapshot> = {}): MaintenanceSnapshot => ({
  effective: false,
  phase: 'active',
  generation: 7,
  quiescedGeneration: 0,
  adminHold: { active: false, reason: null, heldAt: null, heldBy: null },
  platformLease: { active: false, leaseId: null, holder: null, acquiredAt: null, expiresAt: null },
  ...input,
})
const lease: AdmissionLease = {
  executionId: 'execution-1',
  token: 'never-serialize-admission-token',
  claimEpoch: 1n,
  generation: 9,
  holderRevision: 2n,
  ownerId: 'owner-runner',
  ownerIncarnation: 'incarnation-1',
}

describe('maintenance pause evidence', () => {
  test('derives admin-only and platform-only blockers from one snapshot', () => {
    expect(
      authoritativePauseEvidence(
        snapshot({
          effective: true,
          adminHold: { active: true, reason: 'secret-reason', heldAt: null, heldBy: 'owner-admin' },
        })
      )
    ).toEqual({
      origin: 'authoritative-refresh',
      generation: 7,
      blockers: [{ kind: 'admin', idHash: 'db0d87d377ff' }],
      subject: null,
    })
    expect(
      authoritativePauseEvidence(
        snapshot({
          effective: true,
          platformLease: {
            active: true,
            leaseId: 'lease-123',
            holder: 'secret-holder',
            acquiredAt: null,
            expiresAt: null,
          },
        })
      )
    ).toEqual({
      origin: 'authoritative-refresh',
      generation: 7,
      blockers: [{ kind: 'platform-lease', idHash: '1be71ac68489' }],
      subject: null,
    })
  })

  test('keeps simultaneous blockers ordered and refuses an unexplained effective snapshot', () => {
    const evidence = authoritativePauseEvidence(
      snapshot({
        effective: true,
        adminHold: { active: true, reason: null, heldAt: null, heldBy: null },
        platformLease: { active: true, leaseId: null, holder: null, acquiredAt: null, expiresAt: null },
      })
    )
    expect(evidence.blockers).toEqual([
      { kind: 'admin', idHash: null },
      { kind: 'platform-lease', idHash: null },
    ])
    expect(() => authoritativePauseEvidence(snapshot({ effective: true }))).toThrow(
      'Maintenance pause evidence has no active blockers'
    )
  })

  test('derives four runner origins from the exact blocked subject', () => {
    const origins: RunnerPauseOrigin[] = [
      'write-phase-begin',
      'write-phase-finish-settlement',
      'write-phase-finish-running',
      'scope-abort-effective-change',
    ]
    for (const origin of origins)
      expect(admissionLeasePauseEvidence(lease, origin)).toEqual({
        origin,
        generation: 9,
        blockers: null,
        subject: {
          kind: 'admission-lease',
          ownerIdHash: '7a1c86382ffb',
          ownerIncarnationHash: 'aed78ef9f422',
          executionIdHash: '63093cff69b8',
        },
      })
  })

  test('defensively freezes the sole generation evidence graph', () => {
    const mutable = {
      origin: 'authoritative-refresh' as const,
      generation: 11,
      blockers: [{ kind: 'admin' as const, idHash: 'owner-hash' }],
      subject: null,
    } as MaintenancePauseEvidence
    const error = new MaintenanceAdmissionPaused(mutable)
    ;(mutable as { generation: number }).generation = 99
    ;(mutable.blockers as unknown as Array<{ kind: 'admin'; idHash: string | null }>)[0]!.idHash = 'changed'
    expect(error.generation).toBe(11)
    expect(error.evidence.generation).toBe(11)
    expect(error.evidence.blockers?.[0]).toEqual({ kind: 'admin', idHash: 'owner-hash' })
    expect([error.evidence, error.evidence.blockers, error.evidence.blockers?.[0]].every(Object.isFrozen)).toBe(true)
    expect(Reflect.set(error, 'generation', 12)).toBe(false)
    expect(Reflect.set(error.evidence, 'generation', 12)).toBe(false)
  })

  test('preserves legacy bytes and exact enumerable shape', () => {
    const error = new MaintenanceAdmissionPaused(admissionLeasePauseEvidence(lease, 'write-phase-begin'))
    expect(error.name).toBe('MaintenanceAdmissionPaused')
    expect(error.message).toBe('Execution is queued until maintenance completes')
    expect(Object.keys(error)).toEqual(['name', 'evidence', 'generation'])
    expect(Object.getOwnPropertyDescriptor(error, 'generation')).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: error.name, evidence: error.evidence, generation: 9 })
  })

  test('never serializes raw blocker or subject identifiers and secrets', () => {
    const authoritative = authoritativePauseEvidence(
      snapshot({
        effective: true,
        adminHold: { active: true, reason: 'secret-reason', heldAt: null, heldBy: 'owner-admin' },
        platformLease: {
          active: true,
          leaseId: 'lease-123',
          holder: 'secret-holder',
          acquiredAt: null,
          expiresAt: null,
        },
      })
    )
    const serialized = JSON.stringify([
      new MaintenanceAdmissionPaused(authoritative),
      new MaintenanceAdmissionPaused(admissionLeasePauseEvidence(lease, 'write-phase-begin')),
    ])
    for (const excluded of [
      'owner-admin',
      'lease-123',
      'owner-runner',
      'incarnation-1',
      'execution-1',
      'never-serialize-admission-token',
      'secret-reason',
      'secret-holder',
    ])
      expect(serialized).not.toContain(excluded)
  })
})
