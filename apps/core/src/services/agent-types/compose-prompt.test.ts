import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, sharedPrompts } from '../../db'
import { SharedPrompt } from '../../entities/SharedPrompt'
import { composeAgentTypePrompt, resetUnknownSharedPromptWarnings } from './compose-prompt'

const ids = ['cp-alpha', 'cp-beta', 'cp-off']

describe('composeAgentTypePrompt', () => {
  beforeAll(async () => {
    await SharedPrompt.upsert({ id: 'cp-alpha', name: 'A', content: '## Alpha\nalpha' })
    await SharedPrompt.upsert({ id: 'cp-beta', name: 'B', content: '## Beta\nbeta' })
    await SharedPrompt.upsert({ id: 'cp-off', name: 'Off', content: '## Off\noff' })
    await db.update(sharedPrompts).set({ disabled: true }).where(eq(sharedPrompts.id, 'cp-off'))
    SharedPrompt.invalidateCache()
  })
  afterAll(async () => {
    await db.delete(sharedPrompts).where(inArray(sharedPrompts.id, ids))
    SharedPrompt.invalidateCache()
  })

  test('joins own prompt and includes in list order with blank lines', async () => {
    expect(await composeAgentTypePrompt({ id: 't', systemPrompt: 'Own.', includes: ['cp-beta', 'cp-alpha'] })).toBe(
      'Own.\n\n## Beta\nbeta\n\n## Alpha\nalpha'
    )
  })
  test('skips disabled and unknown includes without failing the turn', async () => {
    expect(
      await composeAgentTypePrompt({ id: 't', systemPrompt: 'Own.', includes: ['cp-off', 'missing', 'cp-alpha'] })
    ).toBe('Own.\n\n## Alpha\nalpha')
  })
  test('returns the own prompt unchanged with no includes', async () => {
    expect(await composeAgentTypePrompt({ id: 't', systemPrompt: 'Own.', includes: null })).toBe('Own.')
  })
  // Compose runs on every turn, so a permanently missing id would otherwise
  // repeat its warning forever; the operator only needs to be told once.
  test('warns once per agent type and unknown id, not once per turn', async () => {
    resetUnknownSharedPromptWarnings()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const type = { id: 'warn-once', systemPrompt: 'Own.', includes: ['cp-gone'] }
      await composeAgentTypePrompt(type)
      await composeAgentTypePrompt(type)
      await composeAgentTypePrompt({ ...type, id: 'warn-once-other' })
      const lines = warn.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('cp-gone'))
      expect(lines.filter((line) => line.includes("'warn-once'")).length).toBe(1)
      expect(lines.filter((line) => line.includes("'warn-once-other'")).length).toBe(1)
    } finally {
      warn.mockRestore()
      resetUnknownSharedPromptWarnings()
    }
  })
})
