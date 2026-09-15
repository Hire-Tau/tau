import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { createBlankWorkflow, type IntegrationOutputFact } from '@tau/shared'
import { workStreamsRouter } from './work-streams'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import { workStreams, squads, agents, agentTypes, integrationOutputEvents } from '../db/schema'
import { AgentType } from '../entities/AgentType'

import { Squad } from '../entities/Squad'
import { WorkStream } from '../entities/WorkStream'
import { createTestGitHubConnection } from '../test-utils/github-connection'
import type { IntegrationOutputAuthority } from '../services/integrations/outputs/types'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  assignRole,
  authHeaders,
  cleanupTestRbac,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)

const wsPrefix = `ws-tracked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const eventIds: string[] = []
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: wsPrefix })
})
afterAll(async () => {
  await cleanupTestRbac(wsPrefix)
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

describe('work-stream tracked-resource routes', () => {
  let testPrefix: string
  let testSquadId: string
  let testAgentTypeId: string
  let repo: string
  let connection: Awaited<ReturnType<typeof createTestGitHubConnection>>

  async function apiFetch(url: string, init?: { method?: string; body?: unknown; token?: string }): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        headers: { ...authHeaders(init?.token ?? admin.token), 'Content-Type': 'application/json' },
      })
    )
  }

  function issueFact(number: number, repository = repo): IntegrationOutputFact {
    return {
      output: 'issue.assigned',
      version: 1,
      eventKey: randomUUID(),
      resourceKey: `${repository}#${number}`,
      occurredAt: new Date().toISOString(),
      data: { repository, issue: { number }, assignee: 'tau-bot' },
      subject: `Issue ${repository}#${number}`,
      body: 'Please take a look.',
    }
  }
  async function insertEvent(fact: IntegrationOutputFact, authority: IntegrationOutputAuthority) {
    const [row] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: `github:${testPrefix}`,
        eventKey: fact.eventKey,
        authority,
        fact,
      })
      .returning()
    eventIds.push(row!.id)
    return row!
  }

  beforeEach(async () => {
    testPrefix = `rt-tracked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    repo = `${testPrefix}/repo`
    await AgentType.upsert({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'Test prompt',
    })
    const squad = await Squad.create({ name: `${testPrefix} Tracked Squad`, purpose: 'Testing tracked links' })
    testSquadId = squad.id
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = testAgentTypeId
    await squad.update({ metadata: { workflow: { kind: 'inline', definition } } })
    connection = await createTestGitHubConnection({ squadId: testSquadId })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquadId))
    await connection.dispose()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('creates one work stream from an integration event and reuses it for the same event', async () => {
    const event = await insertEvent(issueFact(4101), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: testSquadId,
    })
    const created = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} from event`, integrationEventId: event.id },
    })
    expect(created.status).toBe(201)
    const stream = (await created.json()) as { id: string; metadata: Record<string, any> }
    expect(stream.metadata.tracked).toHaveLength(1)
    expect(stream.metadata.tracked[0]).toMatchObject({
      integration: 'github',
      repository: repo,
      kind: 'issue',
      number: 4101,
      origin: { eventId: event.id, output: 'issue.assigned' },
    })

    const again = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} from event again`, integrationEventId: event.id },
    })
    expect(again.status).toBe(200)
    const reused = (await again.json()) as { id: string; reusedFromEvent: boolean }
    expect(reused).toMatchObject({ id: stream.id, reusedFromEvent: true })
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(1)
  })

  it('refuses to create from an event another squad observed', async () => {
    const other = await Squad.create({ name: `${testPrefix} Other Squad`, purpose: 'Other' })
    const event = await insertEvent(issueFact(4102), {
      kind: 'connection',
      connectionId: connection.id,
      squadId: other.id,
    })
    const response = await apiFetch('/api/workstreams', {
      method: 'POST',
      body: { squadId: testSquadId, title: `${testPrefix} foreign event`, integrationEventId: event.id },
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBeString()
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, testSquadId))).toHaveLength(0)
  })

  it('lists, adds and removes tracked links for readers and updaters', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} links`, metadata: {} })
      .returning()
    const id = row!.id

    const empty = await apiFetch(`/api/workstreams/${id}/tracked`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ resources: [], subscriptions: 'no-flow' })

    const added = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(added.status).toBe(200)
    const addedBody = (await added.json()) as { added: Array<{ number: number }>; resources: unknown[] }
    expect(addedBody.added).toHaveLength(1)
    expect(addedBody.added[0]!.number).toBe(4201)
    expect(addedBody.resources).toHaveLength(1)

    const again = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'POST',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(again.status).toBe(200)
    expect((await again.json()).added).toEqual([])

    const listed = await apiFetch(`/api/workstreams/${id}/tracked`)
    expect((await listed.json()).resources).toHaveLength(1)

    const removed = await apiFetch(`/api/workstreams/${id}/tracked`, {
      method: 'DELETE',
      body: { url: `https://github.com/${repo}/issues/4201` },
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ removed: true, resources: [] })
  })

  it('refuses to untrack the designated delivery change request', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({
        squadId: testSquadId,
        title: `${testPrefix} delivery`,
        metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 4301 } } },
      })
      .returning()
    const response = await apiFetch(`/api/workstreams/${row!.id}/tracked`, {
      method: 'DELETE',
      body: { url: `https://github.com/${repo}/pull/4301` },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'delivery_change_request' })
  })

  it('requires workstreams:update to change tracked links', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} rbac`, metadata: {} })
      .returning()
    const reader = await createTestUser({ prefix: wsPrefix })
    const role = await createTestRole({ prefix: wsPrefix, permissions: ['workstreams:read'] })
    await assignRole({ userId: reader.id, roleId: role.id, scope: 'squad', squadId: testSquadId })
    const url = `https://github.com/${repo}/issues/4401`
    expect((await apiFetch(`/api/workstreams/${row!.id}/tracked`, { token: reader.token })).status).toBe(200)
    expect(
      (await apiFetch(`/api/workstreams/${row!.id}/tracked`, { method: 'POST', body: { url }, token: reader.token }))
        .status
    ).toBe(403)
    expect(
      (await apiFetch(`/api/workstreams/${row!.id}/tracked`, { method: 'DELETE', body: { url }, token: reader.token }))
        .status
    ).toBe(403)
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
  })

  it('rejects invalid tracked metadata written through PATCH', async () => {
    const [row] = await db
      .insert(workStreams)
      .values({ squadId: testSquadId, title: `${testPrefix} patch`, metadata: {} })
      .returning()
    const response = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ bad: true }] } },
    })
    expect(response.status).toBe(400)
    expect((await WorkStream.mustFind(row!.id)).metadata).toEqual({})
    const accepted = await apiFetch(`/api/workstreams/${row!.id}`, {
      method: 'PATCH',
      body: { metadata: { tracked: [{ integration: 'github', repository: repo, kind: 'issue', number: 4501 }] } },
    })
    expect(accepted.status).toBe(200)
    expect((await WorkStream.mustFind(row!.id)).metadata).toMatchObject({ tracked: [{ number: 4501 }] })
  })
})
