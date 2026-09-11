import { afterEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, schedules, squads, users, workStreams } from '../../db/schema'
import { eventSquadId, topicScope } from './topic-scope'

const squadAId = '44444444-4444-4444-8444-444444444444'
const squadBId = '55555555-5555-4555-8555-555555555555'
const agentId = '66666666-6666-4666-8666-666666666666'
const ownerUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const workStreamId = '77777777-7777-4777-8777-777777777777'
const squadScheduleId = '88888888-8888-4888-8888-888888888888'
const agentScheduleId = '99999999-9999-4999-8999-999999999999'

afterEach(async () => {
  await db.delete(schedules).where(inArray(schedules.id, [squadScheduleId, agentScheduleId]))
  await db.delete(workStreams).where(eq(workStreams.id, workStreamId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(squads).where(inArray(squads.id, [squadAId, squadBId]))
  await db.delete(users).where(eq(users.id, ownerUserId))
})

async function seedSquad(id: string, name: string): Promise<void> {
  await db.insert(squads).values({ id, name, purpose: 'topic scope test' }).onConflictDoNothing()
}

describe('ws topic scope resolver', () => {
  test('squad instance topic resolves to that squad', async () => {
    expect(await topicScope('squads:squad-a')).toEqual({ kind: 'squad', squadId: 'squad-a' })
  })

  test('agent instance topic resolves to the agent squad', async () => {
    await seedSquad(squadAId, 'Squad A')
    await db.insert(agents).values({ id: agentId, agentTypeId: 'worker', squadId: squadAId })

    expect(await topicScope(`agents:${agentId}`)).toEqual({ kind: 'squad', squadId: squadAId })
  })

  test('agent squad takes precedence over its private owner', async () => {
    await seedSquad(squadAId, 'Squad A')
    await db.insert(users).values({ id: ownerUserId, email: 'topic-scope-owner@example.com' })
    await db.insert(agents).values({ id: agentId, agentTypeId: 'system-manager', squadId: squadAId, ownerUserId })

    expect(await topicScope(`agents:${agentId}`)).toEqual({ kind: 'squad', squadId: squadAId })
  })

  test('owned squad-less agent resolves to its private owner', async () => {
    await db.insert(users).values({ id: ownerUserId, email: 'topic-scope-owner@example.com' })
    await db.insert(agents).values({ id: agentId, agentTypeId: 'system-manager', ownerUserId })

    expect(await topicScope(`agents:${agentId}`)).toEqual({ kind: 'owner', ownerUserId })
  })

  test('unowned squad-less agent resolves to the system agents:read surface', async () => {
    await db.insert(agents).values({ id: agentId, agentTypeId: 'artifact-builder' })

    expect(await topicScope(`agents:${agentId}`)).toEqual({ kind: 'permission', permission: 'agents:read' })
  })

  test('missing and malformed agents are unavailable', async () => {
    expect(await topicScope(`agents:${agentId}`)).toEqual({ kind: 'unavailable' })
    expect(await topicScope('agents:not-an-id')).toEqual({ kind: 'unavailable' })
  })

  test('workstream instance topic resolves to the work stream squad', async () => {
    await seedSquad(squadAId, 'Squad A')
    await db.insert(workStreams).values({ id: workStreamId, squadId: squadAId, title: 'Test work stream' })

    expect(await topicScope(`workstreams:${workStreamId}`)).toEqual({ kind: 'squad', squadId: squadAId })
  })

  test('squad-scoped schedule instance topic resolves to the schedule squad', async () => {
    await seedSquad(squadAId, 'Squad A')
    await db.insert(schedules).values({
      id: squadScheduleId,
      scopeType: 'squad',
      scopeId: squadAId,
      name: 'Squad schedule',
      schedule: { type: 'interval', interval: '1h' },
      action: { type: 'inbox_message', content: 'hello' },
    })

    expect(await topicScope(`schedules:${squadScheduleId}`)).toEqual({ kind: 'squad', squadId: squadAId })
  })

  test('non-squad schedule instance topic resolves unresolved', async () => {
    await seedSquad(squadAId, 'Squad A')
    await db.insert(agents).values({ id: agentId, agentTypeId: 'worker', squadId: squadAId })
    await db.insert(schedules).values({
      id: agentScheduleId,
      scopeType: 'agent',
      scopeId: agentId,
      name: 'Agent schedule',
      schedule: { type: 'interval', interval: '1h' },
      action: { type: 'inbox_message', content: 'hello' },
    })

    expect(await topicScope(`schedules:${agentScheduleId}`)).toEqual({ kind: 'unresolved' })
  })

  test('inbox instance topic resolves to recipient scope', async () => {
    expect(await topicScope('inbox:user-a')).toEqual({ kind: 'recipient', recipientId: 'user-a' })
  })

  test('collection topics have no concrete subscription squad', async () => {
    expect(await topicScope('agents')).toEqual({ kind: 'collection' })
  })

  test('eventSquadId returns squad-bearing event scopes and worker global scope', () => {
    expect(eventSquadId('squad.updated', { squadId: 'squad-a' })).toBe('squad-a')
    expect(eventSquadId('workStream.updated', { squadId: 'squad-b', workStreamId: 'ws-1' })).toBe('squad-b')
    expect(eventSquadId('squadRelationship.created', { sourceSquadId: 'squad-c' })).toBe('squad-c')
    expect(eventSquadId('worker.status', { status: 'ok' })).toBe('global')
    expect(eventSquadId('message.created', { agentId: 'agent-a' })).toBeNull()
    // Admin-global, machines-style fail-closed: no squadId on the payload, so
    // this falls through to null — only 'all'-access (full-access) clients
    // receive it (see manager.ts's canReceive).
    expect(eventSquadId('onboarding.updated', {})).toBeNull()
  })
})
