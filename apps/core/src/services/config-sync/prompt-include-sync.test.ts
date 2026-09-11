import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, promptIncludes } from '../../db'
import { PromptInclude } from '../../entities/PromptInclude'
import { PromptIncludeSync, parsePromptIncludeMarkdown } from './prompt-include-sync'

const sync = new PromptIncludeSync()

describe('parsePromptIncludeMarkdown', () => {
  test('names the block from its first heading and describes it from the first paragraph', () => {
    const parsed = parsePromptIncludeMarkdown('## Squad rules\n\nHow squads coordinate.\n\nMore.', 'squad-rules')
    expect(parsed).toEqual({
      id: 'squad-rules',
      name: 'Squad rules',
      description: 'How squads coordinate.',
      content: '## Squad rules\n\nHow squads coordinate.\n\nMore.',
    })
  })
  test('falls back to the id when there is no heading', () => {
    expect(parsePromptIncludeMarkdown('plain text', 'rules').name).toBe('rules')
  })
  test('rejects an empty block or an invalid id', () => {
    expect(() => parsePromptIncludeMarkdown('', 'rules')).toThrow()
    expect(() => parsePromptIncludeMarkdown('x', '../evil')).toThrow()
  })
})

describe('PromptIncludeSync', () => {
  afterAll(async () => {
    await db.delete(promptIncludes).where(eq(promptIncludes.id, 'custom-block'))
  })

  test('loads every bundled include with its file stem as id', async () => {
    const ids = (await sync.loadFromDir()).map((i) => i.id).sort()
    expect(ids).toEqual(['rules', 'slot-manager', 'squad-dynamic-context', 'squad-rules', 'subagents'])
  })

  test('sync stores the blocks with a template and no overrides', async () => {
    await sync.sync()
    const rules = await PromptInclude.mustFind('squad-rules')
    expect(rules.content).toContain('### Questions, waits, and pause')
    expect(rules.yamlFieldOverrides).toEqual([])
    expect(rules.toJson().hasTemplate).toBe(true)
  })

  test('an admin edit becomes a content override that survives resync; revert clears it', async () => {
    await sync.sync()
    const original = (await PromptInclude.mustFind('subagents')).content
    await PromptInclude.upsert({ id: 'subagents', name: 'Subagents', content: original + '\nLocal addition.' })
    await sync.recomputeFieldOverrides('subagents')
    await sync.sync()
    expect((await PromptInclude.mustFind('subagents')).content).toContain('Local addition.')
    expect((await PromptInclude.mustFind('subagents')).yamlFieldOverrides).toEqual(['content'])
    await sync.revertToTemplate('subagents')
    expect((await PromptInclude.mustFind('subagents')).content).toBe(original)
  })

  test('a custom block without a template is kept across sync', async () => {
    await PromptInclude.upsert({ id: 'custom-block', name: 'Custom', content: 'Be brief.' })
    await sync.sync()
    expect(await PromptInclude.find('custom-block')).not.toBeNull()
  })
})
