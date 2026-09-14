import { expect, test } from 'bun:test'
import { createWorkStreamSchema, updateWorkStreamSchema } from './schemas'

test('cleanup setting preserves explicit true and false at creation and update', () => {
  for (const autoCleanupWorktree of [true, false]) {
    expect(createWorkStreamSchema.parse({ squadId: 'squad', title: 'work', autoCleanupWorktree })).toHaveProperty(
      'autoCleanupWorktree',
      autoCleanupWorktree
    )
    expect(updateWorkStreamSchema.parse({ autoCleanupWorktree })).toEqual({ autoCleanupWorktree })
  }
})

test('cleanup setting rejects coercion and leaves omission to the persisted default', () => {
  for (const autoCleanupWorktree of ['false', 'true', 0, 1, null, [], {}]) {
    expect(createWorkStreamSchema.safeParse({ squadId: 'squad', title: 'work', autoCleanupWorktree }).success).toBe(
      false
    )
    expect(updateWorkStreamSchema.safeParse({ autoCleanupWorktree }).success).toBe(false)
  }
  expect(updateWorkStreamSchema.parse({})).not.toHaveProperty('autoCleanupWorktree')
  expect(createWorkStreamSchema.parse({ squadId: 'squad', title: 'work' })).not.toHaveProperty('autoCleanupWorktree')
})
