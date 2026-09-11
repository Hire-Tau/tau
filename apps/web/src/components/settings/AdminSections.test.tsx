import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { UsersSection } from './UsersSection'
import { RolesSection } from './RolesSection'
import { SessionsSection } from './SessionsSection'

function renderWithData(ui: ReactNode, seed: (queryClient: QueryClient) => void): string {
  const queryClient = new QueryClient()
  seed(queryClient)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('RBAC admin settings sections', () => {
  test('UsersSection renders seeded users and invite control', () => {
    const html = renderWithData(<UsersSection />, (queryClient) => {
      queryClient.setQueryData(queryKeys.users.list(), [
        {
          id: 'u1',
          email: 'admin@example.com',
          displayName: 'Admin',
          disabledAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          hasPasskey: true,
          passkeyCount: 1,
          inviteExpiresAt: null,
        },
      ])
      queryClient.setQueryData(queryKeys.roles.list(), [])
    })

    expect(html).toContain('Manage users and their role assignments')
    expect(html).toContain('admin@example.com')
    expect(html).toContain('Invite User')
  })

  test('RolesSection renders seeded roles and create control', () => {
    const html = renderWithData(<RolesSection />, (queryClient) => {
      queryClient.setQueryData(queryKeys.roles.list(), [
        { id: 'r1', name: 'Admin', slug: 'admin', permissions: ['*'], isSystem: true },
      ])
    })

    expect(html).toContain('Define roles with specific permissions')
    expect(html).toContain('Admin')
    expect(html).toContain('Create Role')
  })

  test('SessionsSection renders seeded sessions and revoke-all control', () => {
    const html = renderWithData(<SessionsSection />, (queryClient) => {
      queryClient.setQueryData(queryKeys.sessions.list(), [
        {
          id: 's1',
          userAgent: 'Chrome',
          ipAddress: '127.0.0.1',
          createdAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-02T00:00:00Z',
        },
      ])
    })

    expect(html).toContain('View and manage your active sessions')
    expect(html).toContain('Chrome')
    expect(html).toContain('Revoke All')
  })
})
