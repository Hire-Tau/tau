import { afterEach, describe, expect, it } from 'bun:test'
import { Squad } from '../../../entities/Squad'
import { clearHostWorkspaceOverrides, getHostWorkspaceOverride } from './workspace-overrides'
import { hydrateHostWorkspaceOverrides } from './workspace-overrides-hydrate'

describe('hydrateHostWorkspaceOverrides', () => {
  const created: Squad[] = []
  afterEach(async () => {
    clearHostWorkspaceOverrides()
    for (const s of created.splice(0)) await s.archive()
  })

  it('loads every non-null override from the DB', async () => {
    const a = await Squad.create({ name: `hydrate-a-${Date.now()}`, purpose: 't' })
    const b = await Squad.create({ name: `hydrate-b-${Date.now()}`, purpose: 't' })
    created.push(a, b)
    await a.update({ hostWorkspacePath: '/srv/a' })
    clearHostWorkspaceOverrides()
    const n = await hydrateHostWorkspaceOverrides()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(getHostWorkspaceOverride(a.id)).toBe('/srv/a')
    expect(getHostWorkspaceOverride(b.id)).toBeUndefined()
  })

  it('excludes an archived squad even when it still has an override set', async () => {
    const c = await Squad.create({ name: `hydrate-c-${Date.now()}`, purpose: 't' })
    created.push(c)
    await c.update({ hostWorkspacePath: '/srv/c' })
    await c.archive()
    clearHostWorkspaceOverrides()
    await hydrateHostWorkspaceOverrides()
    expect(getHostWorkspaceOverride(c.id)).toBeUndefined()
  })
})
