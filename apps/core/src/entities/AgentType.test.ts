import { describe, it, expect, afterEach } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { db } from '../db'
import { agentTypes } from '../db/schema'
import { AgentType } from './AgentType'

describe('AgentType cache', () => {
  const prefix = `attype-cache-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  afterEach(async () => {
    await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
    AgentType.invalidateCache()
  })

  it('caches find() results on their own timestamp — no prior list() call required', async () => {
    // The old cache had ONE global lastCacheRefresh that only list() set, so in
    // a process that never called list(), every find() hit the DB.
    const id = `${prefix}-a`
    await AgentType.upsert({ id, name: 'A', systemPrompt: 'p' })
    AgentType.invalidateCache()
    const first = await AgentType.find(id)
    await db.update(agentTypes).set({ name: 'RAW' }).where(eq(agentTypes.id, id))
    const second = await AgentType.find(id)
    expect(second!.name).toBe(first!.name)
    AgentType.invalidateCache()
    expect((await AgentType.find(id))!.name).toBe('RAW')
  })

  it('findMany returns a map of found types, serving cached entries and loading the rest', async () => {
    const a = `${prefix}-m1`
    const b = `${prefix}-m2`
    await AgentType.upsert({ id: a, name: 'M1', systemPrompt: 'p' })
    await AgentType.upsert({ id: b, name: 'M2', systemPrompt: 'p' })
    AgentType.invalidateCache()
    await AgentType.find(a) // warm one entry
    const found = await AgentType.findMany([a, b, a, `${prefix}-missing`])
    expect([...found.keys()].sort()).toEqual([a, b].sort())
    expect(found.get(b)!.name).toBe('M2')
    // Both are now cached: a raw rename is not observed within the TTL.
    await db.update(agentTypes).set({ name: 'RAW' }).where(eq(agentTypes.id, b))
    expect((await AgentType.find(b))!.name).toBe('M2')
  })
})
