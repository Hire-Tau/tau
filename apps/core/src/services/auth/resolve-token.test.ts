import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTokens, agentTypes, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { User } from '../../entities/User'
import { randomUUID } from 'crypto'
import {
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestCredential,
  createTestUser,
} from '../../test-utils/rbac'
import { resetSecretStore } from '../secrets'
import { resolveToken, resolveTokenContext } from './resolve-token'

const PREFIX = 'resolve-token-test'

async function cleanup() {
  const testAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(like(agents.agentTypeId, `${PREFIX}%`))
  const agentIds = testAgents.map((agent) => agent.id)
  if (agentIds.length > 0) {
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, agentIds))
  }
  await db.delete(agents).where(like(agents.agentTypeId, `${PREFIX}%`))
  await db.delete(agentTypes).where(like(agentTypes.id, `${PREFIX}%`))
  await db.delete(squads).where(like(squads.name, `${PREFIX}%`))
  await cleanupTestRbac(PREFIX)
}

async function createAgentFixture(suffix: string) {
  const [squad] = await db
    .insert(squads)
    .values({ name: `${PREFIX}-squad-${suffix}`, purpose: 'Resolve token test squad' })
    .returning()

  const agentTypeId = `${PREFIX}-agent-type-${suffix}`
  await AgentType.create({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: `Resolve Token Test ${suffix}`,
    systemPrompt: 'Test',
  })

  const agent = await Agent.create({ agentTypeId, squadId: squad.id })
  return { agent, squad }
}

beforeEach(cleanup)
afterEach(cleanup)

describe('resolveToken — disabled agent-token owner', () => {
  test('agent token owned by a disabled user is rejected', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const { agent, squad } = await createAgentFixture('owned')
    const { token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: user.id })

    expect(await resolveToken(token)).toMatchObject({ type: 'agent', agentId: agent.id, userId: user.id })
    expect(await resolveTokenContext(token)).toEqual({
      identity: {
        type: 'agent',
        agentId: agent.id,
        squadId: squad.id,
        userId: user.id,
      },
      deviceTokenId: null,
    })

    const owner = await User.findById(user.id)
    await owner!.disable()

    expect(await resolveToken(token)).toBeNull()
  })

  test('agent token owned by a missing user is rejected', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const { agent, squad } = await createAgentFixture('missing-owner')
    const { id, token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id, userId: user.id })

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.update(agentTokens).set({ userId: randomUUID() }).where(eq(agentTokens.id, id))
    })

    expect(await resolveToken(token)).toBeNull()
  })

  test('agent token with no owner user is unaffected', async () => {
    const { agent, squad } = await createAgentFixture('ownerless')
    const { token } = await createTestAgentToken({ agentId: agent.id, squadId: squad.id })

    expect(await resolveToken(token)).toMatchObject({ type: 'agent', agentId: agent.id, squadId: squad.id })
  })
})

describe('resolveToken — TAU_PASSWORD gated on admin passkey', () => {
  const originalPassword = process.env.TAU_PASSWORD
  const testPassword = `resolve-token-pw-${randomUUID()}`

  beforeEach(() => {
    process.env.TAU_PASSWORD = testPassword
    resetSecretStore()
  })

  afterEach(() => {
    if (originalPassword !== undefined) process.env.TAU_PASSWORD = originalPassword
    else delete process.env.TAU_PASSWORD
    resetSecretStore()
  })

  test('restored state: password resolves to legacy identity when admin rows exist but hold no passkey', async () => {
    // Cross-subdomain restore — admin/role rows survive, credentials stripped.
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })

    expect(await resolveToken(testPassword)).toEqual({ type: 'legacy' })
    expect(await resolveTokenContext(testPassword)).toEqual({
      identity: { type: 'legacy' },
      deviceTokenId: null,
    })
  })

  test('self-heals: password stops resolving the moment an admin registers a passkey', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    expect(await resolveToken(testPassword)).toEqual({ type: 'legacy' })

    await createTestCredential({ userId: admin.id })
    expect(await resolveToken(testPassword)).toBeNull()
  })

  test('a wrong password never resolves, even in the restored state', async () => {
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })

    expect(await resolveToken('not-the-password')).toBeNull()
  })
})
