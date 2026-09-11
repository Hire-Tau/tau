import { test, expect } from 'bun:test'
import { linearPlugin, linearQuery } from './plugin'
import { linearOutputAdapter } from './outputs'
import { canReceiveLinearAssignment } from './ingress'

test('Linear checks GraphQL errors and validates an API key without leaking provider error text', async () => {
  const old = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: 'sensitive provider detail' }] })) as unknown as typeof fetch
    await expect(linearQuery('test-key', '{}')).rejects.toThrow('provider_query_failed')
    globalThis.fetch = (async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('test-key')
      return Response.json({ data: { viewer: { id: 'viewer' } } })
    }) as typeof fetch
    expect(
      await linearPlugin.runtime.provider.validate({ credential: 'test-key', configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: ['issues:read'] })
  } finally {
    globalThis.fetch = old
  }
})
test('Linear assignment outputs are stable and require account, team, and current assignment agreement', () => {
  const issue = { id: 'issue', teamId: 'team', assigneeId: 'user', title: 'Fix bug', updatedAt: '2026-09-07T10:00:00Z' }
  const event = { type: 'Issue', payload: { action: 'update', updatedFrom: { assigneeId: null }, data: issue } }
  const facts = linearOutputAdapter.normalize(event)
  expect(facts).toHaveLength(1)
  expect(linearOutputAdapter.normalize(event)).toEqual(facts)
  expect(
    linearOutputAdapter.normalize({ ...event, payload: { ...event.payload, updatedFrom: { title: 'old' } } })
  ).toEqual([])
  const access = { viewer: { id: 'user' }, issue: { id: 'issue', team: { id: 'team' }, assignee: { id: 'user' } } }
  expect(canReceiveLinearAssignment(access, issue)).toBe(true)
  expect(canReceiveLinearAssignment({ ...access, viewer: { id: 'other' } }, issue)).toBe(false)
  expect(canReceiveLinearAssignment({ ...access, issue: null }, issue)).toBe(false)
  expect(canReceiveLinearAssignment(access, { ...issue, teamId: 'other' })).toBe(false)
  expect(canReceiveLinearAssignment({ ...access, issue: { ...access.issue, assignee: { id: 'other' } } }, issue)).toBe(
    false
  )
})
