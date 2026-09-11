import * as piCatalog from '@earendil-works/pi-ai/compat'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { agentTypes, db, modelTiers } from '../../db'
import { ModelTierSync } from './model-tier-sync'
class TestSync extends ModelTierSync {
  constructor(public override readonly directory: string) {
    super()
  }
}
const yaml = (label = 'Test') =>
  `slug: test-tier\nlabel: ${label}\ndescription: test\nchain: openai:gpt-5.2:low\nsortOrder: 10\n`
describe('ModelTierSync', () => {
  let directory: string
  let sync: TestSync
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'tier-sync-'))
    sync = new TestSync(directory)
    await db.delete(agentTypes)
    await db.delete(modelTiers)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  test('preserves a direct-valid tier whose OpenRouter slug is absent', () => {
    const catalog = {
      getProviders: () => [{ id: 'openai' }, { id: 'openrouter' }],
      getModel: (provider: string, modelId: string) =>
        provider === 'openai' && modelId === 'gpt-test' ? ({ provider, id: modelId } as any) : undefined,
    }
    expect(
      new ModelTierSync(catalog).parse(
        'slug: invalid-router\nlabel: Invalid\nchain: openai:gpt-test:high\nsortOrder: 1\n'
      ).chain
    ).toBe('openai:gpt-test:high')
  })

  test('sync warns and continues for a mixed malformed persisted legacy chain', async () => {
    await db.insert(modelTiers).values({
      slug: 'mixed-legacy',
      label: 'Mixed',
      chain: 'malformed,anthropic:claude-sonnet-5:high',
    })
    const warn = spyOn((sync as any).log, 'warn')
    await expect(sync.sync()).resolves.toMatchObject({ deleted: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed legacy entry 'malformed'"))
    expect(await db.select().from(modelTiers)).toHaveLength(1)
  })

  test('sync accepts provider/model syntax without crashing OpenRouter inspection', async () => {
    writeFileSync(
      join(directory, 'slash.yaml'),
      'slug: slash-tier\nlabel: Slash\nchain: anthropic/claude-sonnet-5:high\nsortOrder: 1\n'
    )
    await sync.sync()
    expect((await db.select().from(modelTiers))[0].chain).toBe('anthropic/claude-sonnet-5:high')
  })

  test('sync leaves an authored OpenRouter candidate untouched instead of deriving it again', async () => {
    const chain = 'openrouter:anthropic/claude-sonnet-5:high'
    writeFileSync(join(directory, 'router.yaml'), `slug: router-tier\nlabel: Router\nchain: ${chain}\nsortOrder: 1\n`)
    await sync.sync()
    expect((await db.select().from(modelTiers))[0].chain).toBe(chain)
  })

  test('warns for the effective admin-overridden chain of a YAML-backed tier', async () => {
    // Keep the missing-fallback fixture stable as Pi adds new OpenRouter models.
    const getModels = piCatalog.getModels
    const catalogSpy = spyOn(piCatalog, 'getModels').mockImplementation((provider) =>
      getModels(provider).filter((model) => provider !== 'openrouter' || model.id !== 'z-ai/glm-5.3')
    )
    const warn = spyOn((sync as any).log, 'warn')
    try {
      writeFileSync(join(directory, 'test.yaml'), yaml())
      await sync.sync()
      await db
        .update(modelTiers)
        .set({ chain: 'zai:glm-5.3:high', yamlFieldOverrides: ['chain'] })
        .where(eq(modelTiers.slug, 'test-tier'))

      await sync.sync()

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping derived OpenRouter fallback for 'zai:glm-5.3:high'")
      )
    } finally {
      catalogSpy.mockRestore()
      warn.mockRestore()
    }
  })

  test('adds YAML tiers with template ownership', async () => {
    writeFileSync(join(directory, 'test.yaml'), yaml())
    await sync.sync()
    const [row] = await db.select().from(modelTiers)
    expect(row.label).toBe('Test')
    expect(row.yamlFieldOverrides).toEqual([])
  })
  test('removes unreferenced YAML-owned tiers', async () => {
    writeFileSync(join(directory, 'test.yaml'), yaml())
    await sync.sync()
    rmSync(join(directory, 'test.yaml'))
    expect((await sync.sync()).deleted).toBe(1)
    expect(await db.select().from(modelTiers)).toEqual([])
  })
  test('supports disable and enable semantics', async () => {
    writeFileSync(join(directory, 'test.yaml'), yaml())
    await sync.sync()
    await sync.setDisabled('test-tier', true)
    expect((await db.select().from(modelTiers))[0].disabled).toBe(true)
    await sync.setDisabled('test-tier', false)
    expect((await db.select().from(modelTiers))[0].disabled).toBe(false)
  })
  test('preserves field overrides while updating YAML fields', async () => {
    writeFileSync(join(directory, 'test.yaml'), yaml())
    await sync.sync()
    await db
      .update(modelTiers)
      .set({ label: 'Admin', yamlFieldOverrides: ['label'] })
      .where(eq(modelTiers.slug, 'test-tier'))
    writeFileSync(join(directory, 'test.yaml'), yaml('Changed'))
    await sync.sync()
    const [row] = await db.select().from(modelTiers)
    expect(row.label).toBe('Admin')
    expect((row.yamlTemplate as { label: string }).label).toBe('Changed')
  })
  test('keeps custom rows absent from YAML', async () => {
    await db.insert(modelTiers).values({ slug: 'custom', label: 'Custom', chain: 'openai:gpt-5.2:low' })
    expect((await sync.sync()).deleted).toBe(0)
    expect(await db.select().from(modelTiers)).toHaveLength(1)
  })
  test('refuses removal of a referenced YAML-owned tier', async () => {
    writeFileSync(join(directory, 'test.yaml'), yaml())
    await sync.sync()
    await db
      .insert(agentTypes)
      .values({ id: 'tier-user', name: 'Tier User', model: '', tier: 'test-tier', systemPrompt: 'test' })
    rmSync(join(directory, 'test.yaml'))
    await expect(sync.sync()).rejects.toThrow("Cannot remove model tier 'test-tier'")
    expect(await db.select().from(modelTiers)).toHaveLength(1)
  })
})
