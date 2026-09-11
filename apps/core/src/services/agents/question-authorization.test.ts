import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, squads } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { canAnswerAgentQuestion } from './question-authorization'

const prefix = `question-authorization-${crypto.randomUUID()}`
let squad: Squad
let staleSquad: Squad
let owner: TestUser
let responder: TestUser
let wildcardAdmin: TestUser
let agentTypeId: string
let runRole: { id: string }

beforeAll(async () => {
  agentTypeId = `${prefix}-type`
  await AgentType.create({ id: agentTypeId, name: 'Question authorization', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'question answer authority' })
  staleSquad = await Squad.create({ name: `${prefix}-stale`, purpose: 'stale serialized squad' })
  owner = await createTestUser({ prefix: `${prefix}-owner` })
  responder = await createTestUser({ prefix: `${prefix}-responder` })
  wildcardAdmin = await createTestUser({ prefix: `${prefix}-admin` })
  runRole = await createTestRole({ prefix: `${prefix}-run`, permissions: ['agents:run'] })
  const wildcardRole = await createTestRole({ prefix: `${prefix}-wildcard`, permissions: ['agents:run'] })
  await assignRole({ userId: wildcardAdmin.id, roleId: wildcardRole.id, scope: 'system' })
})

afterAll(async () => {
  await db.delete(agents).where(eq(agents.agentTypeId, agentTypeId))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(squads).where(eq(squads.id, staleSquad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  await cleanupTestRbac(prefix)
})

describe('question answer authority', () => {
  test('squad scope takes precedence over stored ownership for answers', async () => {
    const target = await Agent.create({ agentTypeId, squadId: squad.id, ownerUserId: owner.id })
    const identity = { type: 'user' as const, userId: owner.id }

    expect(await canAnswerAgentQuestion(identity, { agentId: target.id })).toBe(false)

    await assignRole({ userId: owner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    expect(await canAnswerAgentQuestion(identity, { agentId: target.id })).toBe(true)
    await db.delete(agents).where(eq(agents.id, target.id))
  })

  test('a private agent stays owner-exclusive for answers', async () => {
    const privateAgent = await Agent.create({ agentTypeId, ownerUserId: owner.id })
    const asOwner = { type: 'user' as const, userId: owner.id }

    expect(await canAnswerAgentQuestion(asOwner, { agentId: privateAgent.id })).toBe(true)
    expect(
      await canAnswerAgentQuestion({ type: 'user' as const, userId: responder.id }, { agentId: privateAgent.id })
    ).toBe(false)
    // A wildcard agents:run grant does not break into a private agent either.
    expect(
      await canAnswerAgentQuestion({ type: 'user' as const, userId: wildcardAdmin.id }, { agentId: privateAgent.id })
    ).toBe(false)
    await db.delete(agents).where(eq(agents.id, privateAgent.id))
  })

  test('dormant is addressable but pending dormancy and terminated are not', async () => {
    const target = await Agent.create({ agentTypeId, squadId: squad.id })
    const identity = { type: 'user' as const, userId: responder.id }
    await assignRole({ userId: responder.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })

    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, target.id))
    expect(await canAnswerAgentQuestion(identity, { agentId: target.id })).toBe(true)

    await db.update(agents).set({ status: 'active', pendingDormancyAt: new Date() }).where(eq(agents.id, target.id))
    expect(await canAnswerAgentQuestion(identity, { agentId: target.id })).toBe(false)

    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: new Date(), pendingDormancyAt: null })
      .where(eq(agents.id, target.id))
    expect(await canAnswerAgentQuestion(identity, { agentId: target.id })).toBe(false)
    await db.delete(agents).where(eq(agents.id, target.id))
  })

  test('dismissal authority ignores termination but preserves canonical resource permission', async () => {
    const storedOwner = await createTestUser({ prefix: `${prefix}-dismiss-owner-${crypto.randomUUID()}` })
    const authorized = await createTestUser({ prefix: `${prefix}-dismiss-authorized-${crypto.randomUUID()}` })
    const role = await createTestRole({
      prefix: `${prefix}-dismiss-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: authorized.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    const target = await Agent.create({ agentTypeId, squadId: squad.id, ownerUserId: storedOwner.id })
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, target.id))

    const question = { agentId: target.id }
    const terminatedTarget = await Agent.mustFind(target.id)
    expect(await canAnswerAgentQuestion({ type: 'user', userId: authorized.id }, question)).toBe(false)
    expect(
      await canAnswerAgentQuestion({ type: 'user', userId: authorized.id }, question, {
        allowTerminatedAgent: true,
        target: terminatedTarget,
      })
    ).toBe(true)
    expect(
      await canAnswerAgentQuestion({ type: 'user', userId: storedOwner.id }, question, {
        allowTerminatedAgent: true,
        target: terminatedTarget,
      })
    ).toBe(false)

    const wrongTarget = await Agent.create({ agentTypeId, squadId: squad.id })
    expect(
      await canAnswerAgentQuestion({ type: 'user', userId: authorized.id }, question, {
        allowTerminatedAgent: true,
        target: wrongTarget,
      })
    ).toBe(false)
    await db.delete(agents).where(eq(agents.id, wrongTarget.id))
    await db.delete(agents).where(eq(agents.id, target.id))
  })

  test('evaluates the current target even for a stale serialized question', async () => {
    const target = await Agent.create({ agentTypeId, ownerUserId: owner.id, squadId: staleSquad.id })
    const mover = await createTestUser({ prefix: `${prefix}-mover-${crypto.randomUUID()}` })
    const identity = { type: 'user' as const, userId: mover.id }
    // A serialized question snapshot whose owner/squad predate the moves below.
    const staleQuestion = { agentId: target.id, ownerUserId: 'former-owner', squadId: staleSquad.id }

    // No agents:run on the agent's squad yet: squad-bound ownership alone grants nothing.
    expect(await canAnswerAgentQuestion(identity, staleQuestion)).toBe(false)

    const staleSquadRole = await createTestRole({
      prefix: `${prefix}-stale-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: mover.id, roleId: staleSquadRole.id, scope: 'squad', squadId: staleSquad.id })
    expect(await canAnswerAgentQuestion(identity, staleQuestion)).toBe(true)

    // The agent moves squads: the snapshot's staleSquad grant must stop working even though the
    // serialized question still says staleSquad.
    await db.update(agents).set({ ownerUserId: null, squadId: squad.id }).where(eq(agents.id, target.id))
    expect(await canAnswerAgentQuestion(identity, staleQuestion)).toBe(false)

    await assignRole({ userId: mover.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    expect(await canAnswerAgentQuestion(identity, staleQuestion)).toBe(true)
    await db.delete(agents).where(eq(agents.id, target.id))
  })
})
