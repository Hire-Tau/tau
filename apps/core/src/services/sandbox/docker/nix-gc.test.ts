import { describe, it, expect } from 'bun:test'
import { randomUUID } from 'crypto'
import { applyNixGc, scanOrphanNixStores, type NixGcDeps } from './nix-gc'

// A live agent id, an orphan (no row), a terminated row, and an orphan whose
// container is still running — the four resolvable `agent_<uuid>` cases.
const liveId = randomUUID()
const orphanId = randomUUID()
const terminatedId = randomUUID()
const dormantId = randomUUID()
const runningId = randomUUID()

function baseDeps(overrides: Partial<NixGcDeps> = {}): NixGcDeps {
  return {
    listStoreEntries: () => [
      '.base', // shared base seed — must never be a candidate
      '.base.tmp-deadbeef', // in-flight seed temp — ignored
      'not-an-agent', // foreign dir — ignored
      'agent_not-a-uuid', // malformed — ignored
      `agent_${liveId}`,
      `agent_${orphanId}`,
      `agent_${terminatedId}`,
      `agent_${dormantId}`,
      `agent_${runningId}`,
    ],
    storeSize: () => 1000,
    lookupAgent: async (id) => {
      if (id === liveId) return { status: 'idle' }
      if (id === dormantId) return { status: 'dormant' }
      if (id === terminatedId) return { status: 'terminated' }
      if (id === runningId) return null // orphan row-wise, but container is up
      return null // orphanId + anything else: no row
    },
    isContainerRunning: (sandboxId) => sandboxId === `agent_${runningId}`,
    reclaim: () => {},
    ...overrides,
  }
}

describe('scanOrphanNixStores', () => {
  it('resolves only strict agent_<uuid> stores, ignoring .base/tmp/foreign/malformed', async () => {
    const scan = await scanOrphanNixStores(baseDeps())
    const ids = scan.candidates.map((c) => c.sandboxId).sort()
    expect(ids).toEqual(
      [
        `agent_${liveId}`,
        `agent_${orphanId}`,
        `agent_${terminatedId}`,
        `agent_${dormantId}`,
        `agent_${runningId}`,
      ].sort()
    )
  })

  it('assigns verdicts and the running flag correctly', async () => {
    const scan = await scanOrphanNixStores(baseDeps())
    const byId = new Map(scan.candidates.map((c) => [c.sandboxId, c]))
    expect(byId.get(`agent_${liveId}`)?.verdict).toBe('live')
    expect(byId.get(`agent_${orphanId}`)?.verdict).toBe('orphaned')
    expect(byId.get(`agent_${terminatedId}`)?.verdict).toBe('terminated')
    expect(byId.get(`agent_${dormantId}`)?.verdict).toBe('live')
    expect(byId.get(`agent_${runningId}`)?.verdict).toBe('orphaned')
    expect(byId.get(`agent_${runningId}`)?.running).toBe(true)
    expect(byId.get(`agent_${orphanId}`)?.running).toBe(false)
  })

  it('counts only orphaned/terminated + not-running stores toward reclaimable bytes', async () => {
    const scan = await scanOrphanNixStores(baseDeps({ storeSize: () => 2048 }))
    // orphan + terminated = 2 stores * 2048; live protected; running excluded.
    expect(scan.totalReclaimableBytes).toBe(2048 * 2)
  })

  it('does NOT reclaim during a dry-run scan', async () => {
    let reclaimCalls = 0
    await scanOrphanNixStores(baseDeps({ reclaim: () => void reclaimCalls++ }))
    expect(reclaimCalls).toBe(0)
  })

  it('returns an empty scan when the nix root has no stores', async () => {
    const scan = await scanOrphanNixStores(baseDeps({ listStoreEntries: () => [] }))
    expect(scan.candidates).toEqual([])
    expect(scan.totalReclaimableBytes).toBe(0)
  })
})

describe('applyNixGc', () => {
  it('reclaims only orphaned/terminated + not-running stores', async () => {
    const reclaimed: string[] = []
    const result = await applyNixGc(baseDeps({ reclaim: (id) => void reclaimed.push(id) }))
    expect(reclaimed.sort()).toEqual([`agent_${orphanId}`, `agent_${terminatedId}`].sort())
    expect(result.reclaimed.sort()).toEqual([`agent_${orphanId}`, `agent_${terminatedId}`].sort())
    expect(result.failed).toEqual([])
    // Never touches live or the running orphan.
    expect(reclaimed).not.toContain(`agent_${liveId}`)
    expect(reclaimed).not.toContain(`agent_${runningId}`)
  })

  it('is best-effort: one reclaim failure does not abort the rest', async () => {
    const reclaimed: string[] = []
    const result = await applyNixGc(
      baseDeps({
        reclaim: (id) => {
          if (id === `agent_${terminatedId}`) throw new Error('boom')
          reclaimed.push(id)
        },
      })
    )
    expect(result.reclaimed).toEqual([`agent_${orphanId}`])
    expect(result.failed).toEqual([`agent_${terminatedId}`])
  })
})
