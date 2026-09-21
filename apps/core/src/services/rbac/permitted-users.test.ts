import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import * as permissions from './permissions'
import { filterUserIdsWithPermission } from './permitted-users'

let hasPermissionSpy: Mock<typeof permissions.hasPermission> | undefined

afterEach(() => {
  hasPermissionSpy?.mockRestore()
  hasPermissionSpy = undefined
})

const SQUAD = '00000000-0000-4000-8000-0000000000aa'

describe('filterUserIdsWithPermission', () => {
  test('keeps the holders and drops the rest', async () => {
    hasPermissionSpy = spyOn(permissions, 'hasPermission').mockImplementation(
      async (identity) => identity.type === 'user' && identity.userId.startsWith('yes')
    )

    expect(await filterUserIdsWithPermission(['yes-1', 'no-1', 'yes-2'], 'actions:read', SQUAD)).toEqual([
      'yes-1',
      'yes-2',
    ])
  })

  test('an empty candidate list asks nothing', async () => {
    hasPermissionSpy = spyOn(permissions, 'hasPermission').mockResolvedValue(true)
    expect(await filterUserIdsWithPermission([], 'actions:read', SQUAD)).toEqual([])
    expect(hasPermissionSpy).not.toHaveBeenCalled()
  })

  /**
   * The point of the helper. Under `Promise.all` a single rejection discarded every candidate that
   * resolved fine, so one unreadable subject silenced the whole batch.
   */
  test('one unresolvable candidate costs only itself, and is reported once for the batch', async () => {
    hasPermissionSpy = spyOn(permissions, 'hasPermission').mockImplementation(async (identity) => {
      if (identity.type === 'user' && identity.userId.startsWith('boom')) throw new Error('role chain unreadable')
      return true
    })
    const reports: Array<{ failed: number; total: number; reason: unknown }> = []

    const permitted = await filterUserIdsWithPermission(
      ['ok-1', 'boom-1', 'ok-2', 'boom-2'],
      'actions:read',
      SQUAD,
      (summary) => reports.push(summary)
    )

    // Fail CLOSED: a rejection is "not permitted", never "assume yes".
    expect(permitted).toEqual(['ok-1', 'ok-2'])
    // One line per batch, not one per failed recipient — a database blip must not write a log line
    // per candidate.
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ failed: 2, total: 4 })
    expect((reports[0].reason as Error).message).toBe('role chain unreadable')
  })

  test('says nothing when every candidate resolves', async () => {
    hasPermissionSpy = spyOn(permissions, 'hasPermission').mockResolvedValue(true)
    const reports: unknown[] = []
    expect(await filterUserIdsWithPermission(['a', 'b'], 'actions:read', SQUAD, (s) => reports.push(s))).toEqual([
      'a',
      'b',
    ])
    expect(reports).toHaveLength(0)
  })
})
