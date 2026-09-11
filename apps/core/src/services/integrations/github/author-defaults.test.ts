import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads, integrationConnections } from '../../../db'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { gitHubAuthorFromProfile, getGitHubAuthorDefaults } from './author-defaults'
useEnabledIntegrationFixtures('github')

test('profile defaults respect private emails and reject mismatched or malformed profiles', () => {
  const account = { version: 1 as const, userId: 123, login: 'tester' }
  const fallback = { login: 'tester', gitUserName: 'tester', gitUserEmail: '123+tester@users.noreply.github.com' }
  expect(gitHubAuthorFromProfile(account)).toEqual(fallback)
  expect(gitHubAuthorFromProfile(account, { id: 123, name: ' Test Person ', email: 'test@example.com' })).toEqual({
    ...fallback,
    gitUserName: 'Test Person',
    gitUserEmail: 'test@example.com',
  })
  expect(gitHubAuthorFromProfile(account, { id: 999, name: 'Other Person', email: 'other@example.com' })).toEqual(
    fallback
  )
  expect(gitHubAuthorFromProfile(account, { id: 123, name: 'Bad\nName', email: 'not an email' })).toEqual(fallback)
})

test('squad defaults use the assigned account and cached profiles cannot bypass disabled authorization', async () => {
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: 'Author defaults', purpose: 'test' })
  const account = await createTestGitHubConnection({ squadId, login: 'selected' })
  let calls = 0
  const request = (async (_url: unknown, init?: RequestInit) => {
    calls++
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer test-access-${account.id}`)
    return Response.json({ id: 123, name: 'Selected Person', email: null })
  }) as typeof fetch
  try {
    expect(await getGitHubAuthorDefaults(squadId, request)).toEqual({
      login: 'selected',
      gitUserName: 'Selected Person',
      gitUserEmail: '123+selected@users.noreply.github.com',
    })
    expect((await getGitHubAuthorDefaults(squadId, request))?.gitUserName).toBe('Selected Person')
    expect(calls).toBe(1)
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, account.id))
    expect(await getGitHubAuthorDefaults(squadId, request)).toBeUndefined()
    expect(calls).toBe(1)
  } finally {
    await account.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})
