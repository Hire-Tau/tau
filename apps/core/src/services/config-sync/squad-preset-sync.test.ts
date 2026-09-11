import { describe, test, expect, beforeEach } from 'bun:test'
import { db, squadPresets } from '../../db'
import { eq } from 'drizzle-orm'
import { SquadPresetSync } from './squad-preset-sync'

describe('SquadPresetSync', () => {
  const sync = new SquadPresetSync()

  beforeEach(async () => {
    await db.delete(squadPresets)
  })

  test('parses scheduled workflows and rejects legacy orchestration', () => {
    const action = (extra: string) => `id: test
name: Test
scheduleTemplates:
  - name: Check
    action:
      type: create_work_stream
      title: Check
      ${extra}
    schedule:
      interval: 1h
`
    expect(
      sync.parse(action('workflow: {kind: preset, id: solo}'), 'test.yaml').scheduleTemplates?.[0].action.workflow
    ).toMatchObject({ kind: 'preset', id: 'solo' })
    expect(() => sync.parse(action('completionMode: direct-merge'), 'test.yaml')).toThrow(/workflow/i)
    expect(() => sync.parse(action('agentIds: []'), 'test.yaml')).toThrow(/workflow/i)
  })

  test('rejects retired worker instructions with guidance to use workflows', () => {
    expect(() => sync.parse('id: test\nname: Test\nworkerInstructions: {}', 'test.yaml')).toThrow(/workflows/)
  })

  test('loads engineering.yaml from config/squad-presets/', async () => {
    const parsed = await sync.loadFromDir()
    expect(parsed.length).toBeGreaterThanOrEqual(1)
    const eng = parsed.find((p) => p.id === 'engineering')
    expect(eng).toBeTruthy()
    expect(eng!.name).toBeTruthy()
  })

  test('syncs all squad presets to DB', async () => {
    const result = await sync.sync()
    expect(result.synced).toBeGreaterThanOrEqual(1)
    expect(result.deleted).toBe(0)

    const rows = await db.select().from(squadPresets)
    expect(rows.length).toBe(result.synced)
    for (const row of rows) {
      expect(row.yamlTemplate).toBeTruthy()
      expect(row.yamlFieldOverrides).toEqual([])
    }
  })

  test('engineering type has expected fields', async () => {
    await sync.sync()
    const rows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(rows).toHaveLength(1)
    const eng = rows[0]
    expect(eng.name).toBe('Engineering Squad')
    expect(eng.purpose).toBeTruthy()
    expect(eng.managerInstructions).toBeNull()
    expect(eng.defaultAgents).toEqual([])
    expect(eng.scheduleTemplates).toEqual([])
  })

  test('engineering is a domain preset without embedded staffing, routing, or schedules', async () => {
    const engineering = (await sync.loadFromDir()).find((type) => type.id === 'engineering')!
    expect(engineering).toBeTruthy()
    expect(engineering.description).toContain('Software development')
    expect(engineering.description).not.toContain('architect → engineer → reviewer')
    expect(engineering.defaultAgents).toEqual([])
    expect(engineering.managerInstructions).toBeUndefined()
    expect(engineering.scheduleTemplates).toEqual([])
  })

  test('sync removes template-owned legacy orchestration and preserves explicit user overrides', async () => {
    await sync.sync()
    const [initial] = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    const oldInstructions = {
      managerInstructions: 'Always staff architect, engineer, reviewer and run their handoffs.',
      scheduleTemplates: [
        {
          name: 'Manager Check-in',
          action: { type: 'inbox_message' as const, target: 'manager', content: 'Check on workers.' },
          schedule: { interval: '1h' },
        },
      ],
    }
    await db
      .update(squadPresets)
      .set({
        ...oldInstructions,
        yamlTemplate: { ...(initial.yamlTemplate as object), ...oldInstructions },
        yamlFieldOverrides: [],
      })
      .where(eq(squadPresets.id, 'engineering'))

    await sync.sync()
    const [cleaned] = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(cleaned.managerInstructions).toBeNull()
    expect(cleaned.scheduleTemplates).toEqual([])
    expect(cleaned.yamlFieldOverrides).toEqual([])

    await db
      .update(squadPresets)
      .set({
        managerInstructions: 'Our team investigates production incidents.',
        yamlFieldOverrides: ['managerInstructions'],
      })
      .where(eq(squadPresets.id, 'engineering'))
    await sync.sync()
    const [customized] = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(customized.managerInstructions).toBe('Our team investigates production incidents.')
    expect(customized.yamlFieldOverrides).toEqual(['managerInstructions'])
    expect(customized.yamlTemplate).toMatchObject({ managerInstructions: null })
  })

  test('toYaml produces valid output', async () => {
    await sync.sync()
    const rows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(rows).toHaveLength(1)
    const yamlStr = sync.toYaml(rows[0] as any)
    expect(yamlStr).toContain('id: engineering')
    expect(yamlStr).toContain('name:')
    expect(yamlStr).not.toContain('updatedBy')
    expect(yamlStr).not.toContain('yamlDrift')
    expect(yamlStr).not.toContain('createdAt')
  })

  test('setDisabled toggles disabled flag', async () => {
    await sync.sync()
    await sync.setDisabled('engineering', true)
    let rows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(rows[0].disabled).toBe(true)

    await sync.setDisabled('engineering', false)
    rows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(rows[0].disabled).toBe(false)
  })

  test('getTemplateDiff works after sync', async () => {
    await sync.sync()
    const diff = await sync.getTemplateDiff('engineering')
    expect(diff.hasDrift).toBe(false)
    expect(diff.current).toBeTruthy()
    expect(diff.template).toBeTruthy()
  })

  test('revertToTemplate restores after admin edit', async () => {
    await sync.sync()
    const originalRows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    const originalName = originalRows[0].name

    await db
      .update(squadPresets)
      .set({ name: 'Changed Name', yamlFieldOverrides: ['name'] })
      .where(eq(squadPresets.id, 'engineering'))
    await sync.revertToTemplate('engineering')

    const rows = await db.select().from(squadPresets).where(eq(squadPresets.id, 'engineering'))
    expect(rows[0].name).toBe(originalName)
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })
})
