import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, promptIncludes } from '../../db'
import { PromptInclude } from '../../entities/PromptInclude'
import { composeAgentTypePrompt } from './compose-prompt'

const ids = ['cp-alpha', 'cp-beta', 'cp-off']

describe('composeAgentTypePrompt', () => {
  beforeAll(async () => {
    await PromptInclude.upsert({ id: 'cp-alpha', name: 'A', content: '## Alpha\nalpha' })
    await PromptInclude.upsert({ id: 'cp-beta', name: 'B', content: '## Beta\nbeta' })
    await PromptInclude.upsert({ id: 'cp-off', name: 'Off', content: '## Off\noff' })
    await db.update(promptIncludes).set({ disabled: true }).where(eq(promptIncludes.id, 'cp-off'))
    PromptInclude.invalidateCache()
  })
  afterAll(async () => {
    await db.delete(promptIncludes).where(inArray(promptIncludes.id, ids))
    PromptInclude.invalidateCache()
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
})
