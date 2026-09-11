import { expect, test } from 'bun:test'
import { githubRepositoryKey, relaySubscribeRequest, relayAckRequest, INSTANCE_INTEGRATION_SCOPES } from './protocol'

test('relay subscriptions accept exact normalized repositories and reject authority/callback injection', () => {
  const body = {
    connectionId: crypto.randomUUID(),
    connectionRevision: crypto.randomUUID(),
    accessToken: 'token',
    repositories: ['Hire-Tau/Tau'],
  }
  expect(relaySubscribeRequest.parse(body).repositories).toEqual(['hire-tau/tau'])
  for (const extra of [{ tenantId: crypto.randomUUID() }, { callbackUrl: 'https://other.test' }])
    expect(relaySubscribeRequest.safeParse({ ...body, ...extra }).success).toBe(false)
  for (const key of ['../private', 'owner/..', 'owner/*', 'owner/repo?token=secret', 'https://github.com/a/b'])
    expect(githubRepositoryKey.safeParse(key).success).toBe(false)
  expect(relaySubscribeRequest.safeParse({ ...body, repositories: Array(101).fill('a/b') }).success).toBe(false)
  expect(INSTANCE_INTEGRATION_SCOPES).toContain('integrations.events:consume')
})
test('acknowledgments require a delivery lease and connection revision', () => {
  expect(
    relayAckRequest.safeParse({ connectionId: crypto.randomUUID(), deliveries: [{ id: crypto.randomUUID() }] }).success
  ).toBe(false)
})
