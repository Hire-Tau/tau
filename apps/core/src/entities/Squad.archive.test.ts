import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync } from 'fs'
import { like, eq } from 'drizzle-orm'
import { Squad } from './Squad'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { db, squads, agentTokens, schedules, channelInstances, memoryDocuments, memoryChunks } from '../db'
import { agentTypes } from '../db/schema'
import { ensureSquadWorkspace } from '../services/squad/workspace'
import { getSquadSshPath, ensureSquadSshDir } from '../services/squad/ssh'

const prefix = `arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const testAgentTypeId = `${prefix}-type`

beforeEach(async () => {
  await AgentType.create({
    id: testAgentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Test Agent Type',
    systemPrompt: 'You are a test agent.',
  })
})

afterEach(async () => {
  await db.delete(squads).where(like(squads.name, `${prefix}%`))
  await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
})

describe('Squad archived filtering', () => {
  it('list() and findAll() exclude archived squads, find(id) resolves them', async () => {
    const s = await Squad.create({ name: `${prefix} A`, purpose: 'p' })
    await db.update(squads).set({ archivedAt: new Date() }).where(eq(squads.id, s.id))

    const listed = await Squad.list()
    expect(listed.find((x) => x.id === s.id)).toBeUndefined()

    const all = await Squad.findAll()
    expect(all.find((x) => x.id === s.id)).toBeUndefined()

    const withArchived = await Squad.list({ includeArchived: true })
    expect(withArchived.find((x) => x.id === s.id)).toBeDefined()

    const found = await Squad.find(s.id)
    expect(found).not.toBeNull()
    expect(found!.isArchived).toBe(true)
  })
})

describe('Squad.archive', () => {
  it('marks archived, preserves the row, and is idempotent', async () => {
    const s = await Squad.create({ name: `${prefix} mark`, purpose: 'p' })
    await s.archive()
    expect(s.isArchived).toBe(true)
    expect(s.status).toBe('archived')
    const [row] = await db.select().from(squads).where(eq(squads.id, s.id))
    expect(row).toBeDefined()
    expect(row.archivedAt).not.toBeNull()
    const firstArchivedAt = s.archivedAt
    await s.archive() // no-op
    const [row2] = await db.select().from(squads).where(eq(squads.id, s.id))
    expect(row2.archivedAt!.getTime()).toBe(firstArchivedAt!.getTime())
  })

  it("revokes the squad's agent tokens but keeps the rows", async () => {
    const s = await Squad.create({ name: `${prefix} tok`, purpose: 'p' })
    const agent = await Agent.create({ name: 'a', squadId: s.id, agentTypeId: testAgentTypeId })
    await agent.createAgentToken()
    await s.archive()
    const tokens = await db.select().from(agentTokens).where(eq(agentTokens.squadId, s.id))
    expect(tokens.length).toBe(1)
    expect(tokens[0].revokedAt).not.toBeNull()
  })

  it('disables schedules and clears channel routing, keeping rows', async () => {
    const s = await Squad.create({ name: `${prefix} sch`, purpose: 'p' })
    await db.insert(schedules).values({
      scopeType: 'squad',
      scopeId: s.id,
      name: 'x',
      enabled: true,
      schedule: {},
      action: {},
    })
    await db.insert(channelInstances).values({
      id: `${prefix}-ch`,
      name: 'test-channel',
      provider: 'discord',
      defaultSquadId: s.id,
    } as typeof channelInstances.$inferInsert)
    await s.archive()
    const [sch] = await db.select().from(schedules).where(eq(schedules.scopeId, s.id))
    expect(sch.enabled).toBe(false)
    const [ch] = await db
      .select()
      .from(channelInstances)
      .where(eq(channelInstances.id, `${prefix}-ch`))
    expect(ch.defaultSquadId).toBeNull()
    await db.delete(channelInstances).where(eq(channelInstances.id, `${prefix}-ch`))
  })

  it('preserves the workspace + ssh dirs on disk by default', async () => {
    const s = await Squad.create({ name: `${prefix} keepdisk`, purpose: 'p' })
    // workspace and ssh dirs are created lazily — ensure they exist for the assertion
    const workspacePath = ensureSquadWorkspace(s.id)
    ensureSquadSshDir(s.id)
    const sshPath = getSquadSshPath(s.id)
    expect(existsSync(workspacePath)).toBe(true)
    expect(existsSync(sshPath)).toBe(true)

    await s.archive() // deleteWorkspace defaults to false

    expect(existsSync(workspacePath)).toBe(true)
    expect(existsSync(sshPath)).toBe(true)
  })

  it('removes the workspace + ssh dirs on disk when deleteWorkspace is set', async () => {
    const s = await Squad.create({ name: `${prefix} rmdisk`, purpose: 'p' })
    const workspacePath = ensureSquadWorkspace(s.id)
    ensureSquadSshDir(s.id)
    const sshPath = getSquadSshPath(s.id)
    expect(existsSync(workspacePath)).toBe(true)
    expect(existsSync(sshPath)).toBe(true)

    await s.archive({ deleteWorkspace: true })

    expect(existsSync(workspacePath)).toBe(false)
    expect(existsSync(sshPath)).toBe(false)
  })

  it('retries explicit workspace cleanup after the squad is archived', async () => {
    const s = await Squad.create({ name: `${prefix} retry-rmdisk`, purpose: 'p' })
    await s.archive()
    const workspacePath = ensureSquadWorkspace(s.id)
    ensureSquadSshDir(s.id)

    await s.archive({ deleteWorkspace: true })

    expect(existsSync(workspacePath)).toBe(false)
    expect(existsSync(getSquadSshPath(s.id))).toBe(false)
  })

  it('hard-deletes memory_chunks but keeps memory_documents', async () => {
    const s = await Squad.create({ name: `${prefix} mem`, purpose: 'p' })
    const [doc] = await db
      .insert(memoryDocuments)
      .values({
        squadId: s.id,
        sourceType: 'memory_file',
        sourceId: 'a.md',
        contentHash: 'h',
      })
      .returning()
    await db.insert(memoryChunks).values({
      squadId: s.id,
      documentId: doc.id,
      chunkIndex: 0,
      content: 'c',
      contentHash: 'h',
    })
    await s.archive()
    const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.squadId, s.id))
    const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, s.id))
    expect(chunks.length).toBe(0)
    expect(docs.length).toBe(1)
  })
})
