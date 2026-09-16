import { describe, test, expect, beforeEach } from 'bun:test'
import { db, notificationConfig } from '../../db'
import { eq } from 'drizzle-orm'
import { NotificationSync } from './notification-sync'

describe('NotificationSync', () => {
  const sync = new NotificationSync()

  beforeEach(async () => {
    await db.delete(notificationConfig)
  })

  test('loads rules.yaml from config/notifications/', async () => {
    const parsed = await sync.loadFromDir()
    expect(parsed.length).toBeGreaterThanOrEqual(1)
    const defaultConfig = parsed.find((p) => p.id === 'default')
    expect(defaultConfig).toBeTruthy()
  })

  test('syncs notification config to DB with id=default', async () => {
    const result = await sync.sync()
    expect(result.synced).toBe(1)
    expect(result.deleted).toBe(0)

    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(rows).toHaveLength(1)
    expect(rows[0].yamlTemplate).toBeTruthy()
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('rules array is populated with events', async () => {
    await sync.sync()
    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = rows[0].rules as any[]
    expect(rules.length).toBeGreaterThanOrEqual(1)
    // Every rule should have channels
    for (const rule of rules) {
      expect(rule.channels).toBeDefined()
      expect(Array.isArray(rule.channels)).toBe(true)
      expect(rule.channels.length).toBeGreaterThan(0)
    }
  })

  test('bundles only high-signal work stream routes for human-attention channels', async () => {
    await sync.sync()
    const [row] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = row.rules as Array<{ event?: string; channels: string[] }>

    expect(rules.find((rule) => rule.event === 'workStream.blocked')).toBeUndefined()
    // Work-stream events carry no recipient, so they never push directly; humans get the watcher
    // inbox notices instead. External squad channels still receive review and done.
    expect(rules.find((rule) => rule.event === 'workStream.review')?.channels).toEqual(['discord', 'slack', 'telegram'])
    expect(rules.find((rule) => rule.event === 'workStream.done')?.channels).toEqual(['discord', 'slack', 'telegram'])
  })

  test('preserves an explicit blocked route when the bundled template omits it', async () => {
    await sync.sync()
    const [initial] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const customBlocked = { event: 'workStream.blocked', channels: ['telegram'] }
    const rules = (initial.rules as any[]).filter((rule) => rule.event !== 'workStream.blocked')
    await db
      .update(notificationConfig)
      .set({
        rules: [...rules, customBlocked],
        yamlFieldOverrides: ['rules.workStream.blocked:{}'],
      })
      .where(eq(notificationConfig.id, 'default'))

    await sync.sync()

    const [upgraded] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(
      ((upgraded.yamlTemplate as { rules: any[] }).rules ?? []).some((rule) => rule.event === 'workStream.blocked')
    ).toBe(false)
    expect((upgraded.rules as any[]).find((rule) => rule.event === 'workStream.blocked')).toEqual(customBlocked)
  })

  test('adds agent question push routing', async () => {
    await sync.sync()
    const [row] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = row.rules as any[]

    expect(rules.filter((rule) => rule.event === 'agent-question.created')).toEqual([
      { event: 'agent-question.created', channels: ['push'] },
    ])
  })

  test('adds a new template rule while preserving customized rules', async () => {
    await sync.sync()
    const [initial] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const withoutQuestion = (initial.rules as any[]).filter((rule) => rule.event !== 'agent-question.created')
    const customizedRules = withoutQuestion.map((rule) =>
      rule.event === 'execution.failed' ? { ...rule, channels: ['console'] } : rule
    )
    const oldTemplate = {
      ...(initial.yamlTemplate as Record<string, unknown>),
      rules: withoutQuestion,
    }
    await db
      .update(notificationConfig)
      .set({
        rules: customizedRules,
        yamlTemplate: oldTemplate,
        yamlFieldOverrides: ['rules.execution.failed:{}'],
      })
      .where(eq(notificationConfig.id, 'default'))

    await sync.sync()

    const [upgraded] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = upgraded.rules as any[]
    expect(rules.find((rule) => rule.event === 'agent-question.created')).toEqual({
      event: 'agent-question.created',
      channels: ['push'],
    })
    expect(rules.find((rule) => rule.event === 'execution.failed')?.channels).toEqual(['console'])
    expect(upgraded.yamlFieldOverrides).toEqual(['rules.execution.failed:{}'])
  })

  test('accepts same-event rules with structurally distinct matches in declared order', () => {
    const content = `rules:
  - event: inbox.messageReceived
    match: { source: fleet-alert }
    channels: [push, discord]
  - event: inbox.messageReceived
    match: { recipientType: [user, system] }
    channels: [push]
`

    expect(() => sync.parse(content, 'distinct.yaml')).not.toThrow()
    expect(sync.parse(content, 'distinct.yaml').rules.map((rule) => rule.match)).toEqual([
      { source: 'fleet-alert' },
      { recipientType: ['user', 'system'] },
    ])
  })

  test('accepts the same match on different events in declared order', () => {
    const content = `rules:
  - event: inbox.messageReceived
    match: { source: fleet-alert }
    channels: [push]
  - event: execution.failed
    match: { source: fleet-alert }
    channels: [console]
`

    expect(() => sync.parse(content, 'cross-event.yaml')).not.toThrow()
    expect(sync.parse(content, 'cross-event.yaml').rules.map((rule) => rule.event)).toEqual([
      'inbox.messageReceived',
      'execution.failed',
    ])
  })

  test('rejects equivalent nested matches despite reordered keys and different explicit ids', () => {
    const content = `rules:
  - id: first
    event: inbox.messageReceived
    match:
      context: { source: fleet-alert, phase: alert }
    channels: [push]
  - id: second
    event: inbox.messageReceived
    match:
      context: { phase: alert, source: fleet-alert }
    channels: [discord]
`

    expect(() => sync.parse(content, 'equivalent.yaml')).toThrow(
      "equivalent.yaml: Rule 1: duplicate rule identity for event 'inbox.messageReceived'"
    )
  })

  test('preserves array order so reversed match arrays remain distinct', () => {
    const content = `rules:
  - event: inbox.messageReceived
    match: { recipientType: [user, system] }
    channels: [push]
  - event: inbox.messageReceived
    match: { recipientType: [system, user] }
    channels: [discord]
`

    expect(() => sync.parse(content, 'array-order.yaml')).not.toThrow()
    expect(sync.parse(content, 'array-order.yaml').rules.map((rule) => rule.match?.recipientType)).toEqual([
      ['user', 'system'],
      ['system', 'user'],
    ])
  })

  test('treats absent match and an empty match object as equivalent', () => {
    const content = `rules:
  - event: inbox.messageReceived
    channels: [push]
  - event: inbox.messageReceived
    match: {}
    channels: [discord]
`

    expect(() => sync.parse(content, 'empty-match.yaml')).toThrow(
      "empty-match.yaml: Rule 1: duplicate rule identity for event 'inbox.messageReceived'"
    )
  })

  test('rejects a duplicate explicit rule id even when matches differ', () => {
    const content = `rules:
  - id: fleet-inbox
    event: inbox.messageReceived
    match: { source: fleet-alert }
    channels: [push]
  - id: fleet-inbox
    event: inbox.messageReceived
    match: { recipientType: system }
    channels: [discord]
`

    expect(() => sync.parse(content, 'duplicate-id.yaml')).toThrow(
      "duplicate-id.yaml: Rule 1: duplicate rule id 'fleet-inbox'"
    )
  })

  test('rejects non-finite match numbers instead of coercing their identity', () => {
    const content = `rules:
  - event: inbox.messageReceived
    match: { score: .nan }
    channels: [push]
`

    expect(() => sync.parse(content, 'non-finite.yaml')).toThrow('Unsupported notification rule match value')
  })

  test('places the stable fleet alert rule before generic inbox routing with exact channels', async () => {
    await sync.sync()
    const [row] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = row.rules as Array<{
      event?: string
      match?: Record<string, unknown>
      channels: string[]
    }>
    const fleetIndex = rules.findIndex(
      (rule) => rule.event === 'inbox.messageReceived' && rule.match?.source === 'fleet-alert'
    )
    const genericInboxIndex = rules.findIndex(
      (rule) => rule.event === 'inbox.messageReceived' && rule.match?.recipientType !== undefined
    )

    expect(fleetIndex).toBeGreaterThanOrEqual(0)
    expect(genericInboxIndex).toBeGreaterThan(fleetIndex)
    expect(rules[fleetIndex]?.channels).toEqual(['push', 'discord', 'slack', 'telegram'])
  })

  test('channels object has push and console', async () => {
    await sync.sync()
    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const channels = rows[0].channels as Record<string, { enabled: boolean }>
    // At minimum, push and console should be configured
    expect(channels.push).toBeDefined()
    expect(channels.console).toBeDefined()
  })

  test('toYaml produces valid output', async () => {
    await sync.sync()
    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(rows).toHaveLength(1)
    const yamlStr = sync.toYaml(rows[0] as any)
    expect(yamlStr).toContain('rules:')
    expect(yamlStr).toContain('channels:')
    expect(yamlStr).not.toContain('updatedBy')
    expect(yamlStr).not.toContain('yamlDrift')
    expect(yamlStr).not.toContain('createdAt')
  })

  test('setDisabled toggles disabled flag', async () => {
    await sync.sync()
    await sync.setDisabled('default', true)
    let rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(rows[0].disabled).toBe(true)

    await sync.setDisabled('default', false)
    rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(rows[0].disabled).toBe(false)
  })

  test('getTemplateDiff works after sync', async () => {
    await sync.sync()
    const diff = await sync.getTemplateDiff('default')
    expect(diff.hasDrift).toBe(false)
    expect(diff.current).toBeTruthy()
    expect(diff.template).toBeTruthy()
  })

  test('revertToTemplate restores after admin edit', async () => {
    await sync.sync()
    const originalRows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const originalRules = originalRows[0].rules

    await db
      .update(notificationConfig)
      .set({ rules: [], yamlFieldOverrides: ['rules'] })
      .where(eq(notificationConfig.id, 'default'))
    await sync.revertToTemplate('default')

    const rows = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    expect(rows[0].rules).toEqual(originalRules)
    expect(rows[0].yamlFieldOverrides).toEqual([])
  })

  test('revertTemplateFields restores one route rule and keeps other rule overrides', async () => {
    await sync.sync()
    const [original] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const templateRules = original.rules as any[]
    const routeRules = templateRules.filter((rule) => rule.event && !rule.id && rule.match === undefined)
    const [firstRule, secondRule] = routeRules
    expect(firstRule).toBeTruthy()
    expect(secondRule).toBeTruthy()
    const firstKey = `${firstRule.event}:{}`
    const secondKey = `${secondRule.event}:{}`

    const editedRules = templateRules.map((rule) =>
      rule.event === firstRule.event || rule.event === secondRule.event ? { ...rule, channels: ['console'] } : rule
    )
    await db
      .update(notificationConfig)
      .set({
        rules: editedRules,
        yamlFieldOverrides: [`rules.${firstKey}`, `rules.${secondKey}`],
      })
      .where(eq(notificationConfig.id, 'default'))

    await sync.revertTemplateFields('default', [`rules.${firstKey}`])

    const [row] = await db.select().from(notificationConfig).where(eq(notificationConfig.id, 'default'))
    const rules = row.rules as any[]
    expect(rules.find((rule) => rule.event === firstRule.event)).toEqual(firstRule)
    expect(rules.find((rule) => rule.event === secondRule.event)?.channels).toEqual(['console'])
    expect(row.yamlFieldOverrides).toEqual([`rules.${secondKey}`])
  })
})
