import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import { agents, agentTokens, agentTypes, executions, inbox, modelTiers, schedules, users } from '../db/schema'
import { AgentType, type AgentTypeRow } from '../entities/AgentType'
import { SUBAGENT_AGENT_TYPE_ID } from '../entities/Subagent'

// Both dispatch test files borrow the one allowlisted type. A reserved session
// holds this lock for the entire fixture lifetime, not just setup/restoration.
export const SUBAGENT_FIXTURE_LOCK = 7_401_983_522

export async function acquireSubagentFixtureLock(): Promise<() => Promise<void>> {
  const client = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0, onnotice: () => {} })
  try {
    const connection = await client.reserve()
    await connection`SELECT pg_advisory_lock(${SUBAGENT_FIXTURE_LOCK})`
    return async () => {
      try {
        connection.release()
      } finally {
        await client.end({ timeout: 5 })
      }
    }
  } catch (error) {
    await client.end({ timeout: 5 })
    throw error
  }
}

export class SubagentTestFixture {
  readonly parentTypeId: string
  readonly tierSlug: string
  readonly agentIds: string[] = []
  readonly userIds: string[] = []
  private releaseLock?: () => Promise<void>
  private previousType?: AgentTypeRow
  private restoreSharedType = false

  constructor(
    prefix: string,
    readonly chain: string
  ) {
    const suffix = crypto.randomUUID()
    this.parentTypeId = `${prefix}-parent-${suffix}`
    this.tierSlug = `${prefix}-standard-${suffix}`
  }

  async setup(): Promise<void> {
    try {
      this.releaseLock = await acquireSubagentFixtureLock()
      ;[this.previousType] = await db.select().from(agentTypes).where(eq(agentTypes.id, SUBAGENT_AGENT_TYPE_ID))
      await AgentType.create({
        id: this.parentTypeId,
        name: 'Subagent test parent',
        model: 'openai-codex:gpt-5.6-sol:low',
        systemPrompt: 'parent',
      })
      await db.insert(modelTiers).values({ slug: this.tierSlug, label: 'Standard test fixture', chain: this.chain })
      // Upsert can commit before its caller observes an error. The ownership
      // predicate in cleanup makes restoration safe even if no row was written.
      this.restoreSharedType = true
      await AgentType.upsert({
        id: SUBAGENT_AGENT_TYPE_ID,
        name: 'Subagent',
        model: '',
        tier: this.tierSlug,
        systemPrompt: 'base',
      })
    } catch (error) {
      await this.cleanup()
      throw error
    }
  }

  async cleanup(): Promise<void> {
    try {
      // Include roots created just before a test failed to register their IDs,
      // then walk every generation before deleting anything (FKs may cascade).
      const roots = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentTypeId, this.parentTypeId))
      const ownedIds = new Set([...this.agentIds, ...roots.map(({ id }) => id)])
      let frontier = [...ownedIds]
      while (frontier.length) {
        const children = await db.select({ id: agents.id }).from(agents).where(inArray(agents.parentAgentId, frontier))
        frontier = children.map(({ id }) => id).filter((id) => !ownedIds.has(id))
        for (const id of frontier) ownedIds.add(id)
      }
      const ids = [...ownedIds]
      if (ids.length) {
        await db.delete(schedules).where(inArray(schedules.scopeId, ids))
        await db.delete(executions).where(inArray(executions.agentId, ids))
        await db.delete(agentTokens).where(inArray(agentTokens.agentId, ids))
        await db.delete(inbox).where(or(inArray(inbox.recipientId, ids), inArray(inbox.senderId, ids)))
        await db.delete(agents).where(inArray(agents.id, ids))
      }
    } finally {
      try {
        if (this.restoreSharedType) {
          // Never delete a pre-existing shared row, or clobber a non-cooperating
          // writer. The unique tier is our ownership marker as well as fixture data.
          const ownedType = and(eq(agentTypes.id, SUBAGENT_AGENT_TYPE_ID), eq(agentTypes.tier, this.tierSlug))
          if (this.previousType) await db.update(agentTypes).set(this.previousType).where(ownedType)
          else await db.delete(agentTypes).where(ownedType)
          this.restoreSharedType = false
        }
        await db.delete(agentTypes).where(eq(agentTypes.id, this.parentTypeId))
        await db.delete(modelTiers).where(eq(modelTiers.slug, this.tierSlug))
        if (this.userIds.length) await db.delete(users).where(inArray(users.id, this.userIds))
      } finally {
        AgentType.invalidateCache()
        // Disposing the private client also releases the session advisory lock on
        // setup/cleanup failure. No lock can escape into the application's pool.
        const release = this.releaseLock
        this.releaseLock = undefined
        await release?.()
      }
    }
  }
}
