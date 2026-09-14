import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFile, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { rolesRouter } from './roles'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import { roles } from '../db/schema'
import { Role, isUserAssignable } from '../entities/Role'
import { RoleSync } from '../services/config-sync/role-sync'
import { MONOREPO_ROOT } from '../lib/paths'
import { createTestAdmin, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/roles', rolesRouter)

const prefix = `applies-to-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

// ── The migration's backfill ─────────────────────────────────────────────────

describe('migration 0078 backfills roles.applies_to by slug', () => {
  const seeded = ['admin', 'operator', 'viewer', 'default-worker', 'default-manager']
  const custom = `${prefix}-custom`

  it('flips the agent-derived slugs to agent and leaves everyone else on user', async () => {
    // Reproduce the pre-migration state: every row on the column default.
    await db.delete(roles).where(inArray(roles.slug, [...seeded, custom]))
    for (const slug of [...seeded, custom]) {
      await db
        .insert(roles)
        .values({ name: `${prefix} ${slug}`, slug, permissions: [], appliesTo: 'user' })
        .onConflictDoNothing()
    }

    // Run the real UPDATE statements out of the migration file, so this test
    // fails if the shipped backfill ever stops covering a slug.
    const migration = await readFile(join(MONOREPO_ROOT, 'apps/core/drizzle/0078_fat_fat_cobra.sql'), 'utf-8')
    const updates = migration
      .split('--> statement-breakpoint')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter((s) => s.toUpperCase().startsWith('UPDATE'))
    expect(updates.length).toBeGreaterThan(0)
    for (const statement of updates) await db.execute(sql.raw(statement))

    const rows = await db
      .select({ slug: roles.slug, appliesTo: roles.appliesTo })
      .from(roles)
      .where(inArray(roles.slug, [...seeded, custom]))
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.appliesTo]))

    expect(bySlug['admin']).toBe('user')
    expect(bySlug['operator']).toBe('user')
    expect(bySlug['viewer']).toBe('user')
    expect(bySlug['default-worker']).toBe('agent')
    expect(bySlug['default-manager']).toBe('agent')
    // Custom roles are only ever assignable to users today, so they stay 'user'.
    expect(bySlug[custom]).toBe('user')

    await db.delete(roles).where(inArray(roles.slug, [...seeded, custom]))
  })
})

// ── The yaml declaration ─────────────────────────────────────────────────────

describe('role sync carries appliesTo from defaults.yaml', () => {
  it('writes the declared value on create and reconciles it on update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'applies-to-sync-'))
    const slugUser = `${prefix}-yaml-user`
    const slugAgent = `${prefix}-yaml-agent`
    const slugBare = `${prefix}-yaml-bare`
    await writeFile(
      join(dir, 'defaults.yaml'),
      `roles:
  - name: ${prefix} Yaml User
    slug: ${slugUser}
    appliesTo: user
    permissions: ['squads:read']
  - name: ${prefix} Yaml Agent
    slug: ${slugAgent}
    readOnly: true
    appliesTo: agent
    permissions: ['squads:read']
  - name: ${prefix} Yaml Bare
    slug: ${slugBare}
    permissions: ['squads:read']
`
    )
    try {
      await new RoleSync(dir).sync()
      const rows = await db
        .select({ slug: roles.slug, appliesTo: roles.appliesTo })
        .from(roles)
        .where(inArray(roles.slug, [slugUser, slugAgent, slugBare]))
      const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.appliesTo]))
      expect(bySlug[slugUser]).toBe('user')
      expect(bySlug[slugAgent]).toBe('agent')
      // Omitted means user — a role that isn't explicitly agent-derived is a human one.
      expect(bySlug[slugBare]).toBe('user')

      // A drifted row must reconcile back to what the yaml declares.
      await db.update(roles).set({ appliesTo: 'user' }).where(eq(roles.slug, slugAgent))
      await new RoleSync(dir).sync()
      const [reconciled] = await db.select().from(roles).where(eq(roles.slug, slugAgent))
      expect(reconciled.appliesTo).toBe('agent')
    } finally {
      await db.delete(roles).where(inArray(roles.slug, [slugUser, slugAgent, slugBare]))
    }
  })

  it('the shipped defaults.yaml declares every agent role as agent', async () => {
    const yaml = await readFile(join(MONOREPO_ROOT, 'config/roles/defaults.yaml'), 'utf-8')
    for (const slug of ['default-worker', 'default-manager']) {
      expect(yaml).toMatch(new RegExp(`slug: ${slug}[\\s\\S]{0,80}?appliesTo: agent`))
    }
    for (const slug of ['admin', 'operator', 'viewer']) {
      expect(yaml).toMatch(new RegExp(`slug: ${slug}\\n(\\s+readOnly: true\\n)?\\s+appliesTo: user`))
    }
  })
})

// ── The API ──────────────────────────────────────────────────────────────────

describe('GET /api/roles exposes and filters on appliesTo', () => {
  const userSlug = `${prefix}-api-user`
  const agentSlug = `${prefix}-api-agent`

  beforeAll(async () => {
    await db.insert(roles).values([
      { name: `${prefix} Api User`, slug: userSlug, permissions: ['squads:read'], appliesTo: 'user' },
      { name: `${prefix} Api Agent`, slug: agentSlug, permissions: ['squads:read'], appliesTo: 'agent' },
    ])
  })

  afterAll(async () => {
    await db.delete(roles).where(inArray(roles.slug, [userSlug, agentSlug]))
  })

  it('returns appliesTo on every role', async () => {
    const res = await app.request('/api/roles', { headers: authHeaders(admin.token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { slug: string; appliesTo: string }[]
    expect(body.find((r) => r.slug === userSlug)?.appliesTo).toBe('user')
    expect(body.find((r) => r.slug === agentSlug)?.appliesTo).toBe('agent')
  })

  it('?assignableTo=user hides the agent roles', async () => {
    const res = await app.request('/api/roles?assignableTo=user', { headers: authHeaders(admin.token) })
    const body = (await res.json()) as { slug: string }[]
    expect(body.map((r) => r.slug)).toContain(userSlug)
    expect(body.map((r) => r.slug)).not.toContain(agentSlug)
  })

  it('a role created through the API defaults to user', async () => {
    const slug = `${prefix}-created`
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${prefix} Created`, slug, permissions: ['squads:read'] }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).appliesTo).toBe('user')
    await db.delete(roles).where(eq(roles.slug, slug))
  })

  it('isUserAssignable accepts user and both, rejects agent', () => {
    expect(isUserAssignable({ appliesTo: 'user' })).toBe(true)
    expect(isUserAssignable({ appliesTo: 'both' })).toBe(true)
    expect(isUserAssignable({ appliesTo: 'agent' })).toBe(false)
  })

  it('Role.toJSON carries appliesTo', async () => {
    const role = await Role.findBySlug(agentSlug)
    expect(role?.toJSON().appliesTo).toBe('agent')
  })
})
