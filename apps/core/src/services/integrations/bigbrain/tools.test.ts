import { expect, test } from 'bun:test'
import { createBigbrainTools, BIGBRAIN_TOOL_NAMES } from './tools'

const secret = 'fixture-bearer'
test('defines four stable server-bound tools without credential parameters', () => {
  const tools = createBigbrainTools({
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: 'squad',
    gate: { check: async () => ({ allowed: false, code: 'connection_disabled' }) } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => false },
  })
  expect(tools.map((tool) => tool.name)).toEqual([...BIGBRAIN_TOOL_NAMES])
  expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toContain('credential')
  expect(JSON.stringify(tools.map((tool) => tool.parameters))).not.toContain('apiBase')
  expect(JSON.stringify(tools.map((tool) => tool.parameters)).toLowerCase()).not.toContain('squadid')
})

test('does not fetch or disclose secrets when a runtime gate denies', async () => {
  let fetches = 0
  const tools = createBigbrainTools({
    agent: { id: 'agent', squadId: 'squad', integrationCapabilities: null },
    squadId: 'squad',
    gate: { check: async () => ({ allowed: false, code: 'capability_not_allowed' }) } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => false },
    fetch: async () => {
      fetches++
      return Response.json({})
    },
  })
  const result = await tools[0]!.execute(
    'call',
    { query: 'test' },
    undefined as any,
    undefined as any,
    undefined as any
  )
  expect(fetches).toBe(0)
  expect(JSON.stringify(result)).not.toContain(secret)
})

test('disables the exact material revision on runtime authentication failure', async () => {
  const disables: unknown[] = []
  const tools = createBigbrainTools({
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: 'squad',
    gate: {
      check: async () => ({
        allowed: true,
        connection: {
          id: 'connection',
          squadId: 'squad',
          credentialRef: 'credential',
          materialRevision: 'revision-a',
          configuration: { version: 1, apiBase: 'https://brain.example' },
        },
      }),
    } as any,
    credentials: { get: () => secret, set: async () => {}, delete: async () => {} },
    audit: { record: async () => {} },
    connections: {
      disableRuntimeAuthFailure: async (input) => {
        disables.push(input)
        return true
      },
    },
    fetch: async () => new Response(null, { status: 401 }),
  })

  await tools[0]!.execute('call', { query: 'test' }, undefined as any, undefined as any, undefined as any)
  expect(disables).toEqual([{ id: 'connection', materialRevision: 'revision-a' }])
})
