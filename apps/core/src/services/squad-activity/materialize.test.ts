import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  inbox,
  messages,
  squadActivity,
  squadActivityMaintenanceLeases,
  squads,
  workStreams,
} from '../../db/schema'
import { materializeSourceGroup } from './materialize'
import { repairSquadActivity } from './repair'
import { listSourceGroupPage } from './families'
import type { SourceGroupCursor } from './source-loaders'

const createdSquads: string[] = []
const leaseTasks: string[] = []
const DAY_MS = 24 * 60 * 60 * 1000
afterEach(async () => {
  for (const task of leaseTasks.splice(0))
    await db.delete(squadActivityMaintenanceLeases).where(eq(squadActivityMaintenanceLeases.task, task))
  for (const id of createdSquads.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
})
describe('Activity materialization', () => {
  test('rejects wrong and expired maintenance fences inside the projection transaction', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-fence-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [stream] = await db.insert(workStreams).values({ squadId: squad.id, title: 'Fenced source' }).returning()
    const task = `repair-fence-${crypto.randomUUID()}`
    const token = crypto.randomUUID()
    leaseTasks.push(task)
    await expect(
      materializeSourceGroup({ family: 'workstream', groupId: stream.id }, { leaseFence: { task, token } } as any)
    ).rejects.toThrow('lease lost')
    await db.insert(squadActivityMaintenanceLeases).values({
      task,
      leaseToken: token,
      leaseUntil: new Date(Date.now() - 1_000),
    })
    await expect(
      materializeSourceGroup({ family: 'workstream', groupId: stream.id }, { leaseFence: { task, token } } as any)
    ).rejects.toThrow('lease lost')
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])
  })

  test('real-time and overlapping repair share extraction and are idempotent', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-materialize-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const fixtureNow = new Date()
    // Keep repair-backed timestamps relative so they stay inside Activity retention as wall time advances.
    const runStartedAt = new Date(fixtureNow.getTime() - DAY_MS)
    expect(fixtureNow.getTime() - runStartedAt.getTime()).toBe(DAY_MS)
    const repairWindow = {
      from: new Date(runStartedAt.getTime() - 60 * 60_000),
      to: new Date(runStartedAt.getTime() + 60 * 60_000),
    }
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        runStartedAt,
        endedAt: new Date(runStartedAt.getTime() + 60_000),
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: '  Building projection\nignored',
      metadata: { executionId: execution.id },
      createdAt: new Date(runStartedAt.getTime() + 30_000),
    })
    const realtime = await materializeSourceGroup({ family: 'chat', groupId: execution.id })
    expect(realtime.upserted).toHaveLength(1)
    expect((await materializeSourceGroup({ family: 'chat', groupId: execution.id })).upserted).toEqual([])
    const first = await repairSquadActivity(repairWindow)
    const second = await repairSquadActivity(repairWindow)
    expect(first.errors).toBe(0)
    expect(second.changed).toBe(0)
    const stored = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(stored.map((row) => row.summary)).toContain('Building projection')
  })

  test('subagent report rows carry the PARENT agent type through the REAL inbox loader', async () => {
    // Regression: loadInboxSnapshot SELECTed sender_parent_type_id but never
    // mapped it to senderParentAgentTypeId, so every lane-22 row fell back to
    // the literal 'subagent' type and rendered "› Subagent" instead of the
    // parent ("› Reviewer"). Extractor tests feed snapshots directly and could
    // not catch the loader gap — this goes through the real loader.
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-subagent-parent-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [parent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'reviewer' }).returning()
    const [sub] = await db
      .insert(agents)
      .values({ squadId: squad.id, agentTypeId: 'subagent', parentAgentId: parent.id })
      .returning()
    const [report] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: parent.id,
        senderType: 'agent',
        senderId: sub.id,
        content: 'Final report: all clear',
        deliveryMode: 'follow-up',
        metadata: {},
      })
      .returning()
    try {
      await materializeSourceGroup({ family: 'inbox', groupId: report.id })
      const [row] = await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, report.id))
      expect(row).toMatchObject({ lane: 22, kind: 'subagent', agentTypeId: 'reviewer' })
      expect(row.summary.startsWith('Subagent sent message to Reviewer:')).toBe(true)
    } finally {
      await db.delete(inbox).where(eq(inbox.id, report.id))
    }
  })

  test('keyset-pages beyond page size and repairs missed inserts and deletes', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-repair-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const fixtureNow = new Date()
    // Keep repair-backed timestamps relative so they stay inside Activity retention as wall time advances.
    const createdAt = new Date(fixtureNow.getTime() - DAY_MS)
    expect(fixtureNow.getTime() - createdAt.getTime()).toBe(DAY_MS)
    const repairWindow = {
      from: new Date(createdAt.getTime() - 60_000),
      to: new Date(createdAt.getTime() + 60_000),
    }
    const inserted = await db
      .insert(workStreams)
      .values(Array.from({ length: 7 }, (_, index) => ({ squadId: squad.id, title: `Repair ${index}`, createdAt })))
      .returning({ id: workStreams.id })
    const expected = new Set(inserted.map((row) => row.id))
    const seen = new Set<string>()
    let cursor: SourceGroupCursor | null = null
    do {
      const page = await listSourceGroupPage('workstream', repairWindow.from, repairWindow.to, cursor, 2)
      for (const id of page.groupIds) if (expected.has(id)) seen.add(id)
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual(expected)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])

    const repaired = await repairSquadActivity({ ...repairWindow, pageSize: 2 })
    expect(repaired.families.workstream.pages).toBeGreaterThan(3)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toHaveLength(7)

    await db.delete(workStreams).where(eq(workStreams.id, inserted[0].id))
    const deletionRepair = await repairSquadActivity({ ...repairWindow, pageSize: 2 })
    expect(deletionRepair.deleted).toBeGreaterThanOrEqual(1)
    const remaining = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(remaining.map((row) => row.rowId)).not.toContain(inserted[0].id)
  })
})
