import { describe, expect, mock, test } from 'bun:test'
import { resolvePermissionSquadScope, scopeAllows, scopeFromUserRoleRows } from './permission-scope'

const permission = 'recommendations:read'
const deniedSquadId = '00000000-0000-4000-8000-000000000002'
const readableSquadId = '00000000-0000-4000-8000-000000000001'

describe('scopeFromUserRoleRows', () => {
  test('system permission allows all squads', () => {
    expect(
      scopeFromUserRoleRows([{ scope: 'system', squadId: null, permissions: ['recommendations:*'] }], permission)
    ).toEqual({ kind: 'all', excludedSquadIds: [] })
  })

  test('a denied override excludes that squad from a readable default', () => {
    expect(
      scopeFromUserRoleRows(
        [
          { scope: 'squad_default', squadId: null, permissions: [permission] },
          { scope: 'squad', squadId: deniedSquadId, permissions: ['agents:read'] },
        ],
        permission
      )
    ).toEqual({ kind: 'all', excludedSquadIds: [deniedSquadId] })
  })

  test('one of several override roles can grant permission', () => {
    expect(
      scopeFromUserRoleRows(
        [
          { scope: 'squad', squadId: readableSquadId, permissions: ['agents:read'] },
          { scope: 'squad', squadId: readableSquadId, permissions: [permission] },
        ],
        permission
      )
    ).toEqual({ kind: 'some', squadIds: [readableSquadId] })
  })

  test('loads every user role row in one bounded call', async () => {
    const loadUserRoleRows = mock(async () =>
      Array.from({ length: 200 }, (_, index) => ({
        scope: 'squad' as const,
        squadId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        permissions: [permission],
      }))
    )
    const scope = await resolvePermissionSquadScope(
      { type: 'user', userId: '00000000-0000-4000-8000-000000000099' },
      permission,
      { loadUserRoleRows }
    )
    expect(loadUserRoleRows).toHaveBeenCalledTimes(1)
    expect(scope.kind === 'some' && scope.squadIds).toHaveLength(200)
  })

  test('canonicalizes duplicate squad ids', () => {
    const scope = scopeFromUserRoleRows(
      [
        { scope: 'squad', squadId: deniedSquadId, permissions: [permission] },
        { scope: 'squad', squadId: readableSquadId, permissions: [permission] },
        { scope: 'squad', squadId: readableSquadId, permissions: [permission] },
      ],
      permission
    )
    expect(scope).toEqual({ kind: 'some', squadIds: [readableSquadId, deniedSquadId].sort() })
    expect(scopeAllows(scope, readableSquadId)).toBe(true)
  })
})
