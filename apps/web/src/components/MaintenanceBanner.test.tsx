import { describe, expect, it } from 'bun:test'
import { maintenanceBannerText } from './MaintenanceBanner'
import type { MaintenanceSnapshot } from '../api/system'

const active: MaintenanceSnapshot = {
  effective: false,
  phase: 'active',
  generation: 0,
  quiescedGeneration: 0,
  adminHold: { active: false, reason: null, heldAt: null, heldBy: null },
  platformLease: { active: false, leaseId: null, holder: null, acquiredAt: null, expiresAt: null },
}

describe('maintenanceBannerText', () => {
  it('does not require the legacy capability flag to explain queuing', () => {
    expect(
      maintenanceBannerText({ effective: true, phase: 'paused' } as Parameters<typeof maintenanceBannerText>[0])
    ).toContain('Work is queued')
  })
  it('is hidden while active', () => expect(maintenanceBannerText(active)).toBeNull())
  it('explains a paused platform lease', () => {
    const text = maintenanceBannerText({
      ...active,
      effective: true,
      phase: 'paused',
      generation: 2,
      quiescedGeneration: 2,
      platformLease: { ...active.platformLease, active: true, holder: 'resize-machine-host:j1' },
    })
    expect(text).toContain('queued and will resume automatically')
    expect(text).not.toContain('resize-machine-host:j1')
  })
})
