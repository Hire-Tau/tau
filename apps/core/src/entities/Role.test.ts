import { describe, it, expect, afterEach } from 'bun:test'
import { like, eq } from 'drizzle-orm'
import { Role } from './Role'
import { db } from '../db'
import { roles, roleAssignments } from '../db/schema'

const PREFIX = 'role-test'

function testSlug(suffix?: string) {
  return `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${suffix ?? ''}`
}

describe('Role entity', () => {
  afterEach(async () => {
    // Clean up: delete role assignments before roles (FK constraint)
    const testRoles = await db
      .select({ id: roles.id })
      .from(roles)
      .where(like(roles.slug, `${PREFIX}%`))
    for (const r of testRoles) {
      await db.delete(roleAssignments).where(eq(roleAssignments.roleId, r.id))
    }
    await db.delete(roles).where(like(roles.slug, `${PREFIX}%`))
  })

  // ---------------------------------------------------------------------------
  // Role.create
  // ---------------------------------------------------------------------------

  describe('Role.create', () => {
    it('creates a role with name, slug, and permissions', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `Test Role ${slug}`,
        slug,
        permissions: ['agents:read', 'squads:read'],
      })

      expect(role.id).toBeDefined()
      expect(role.slug).toBe(slug)
      expect(role.permissions).toEqual(['agents:read', 'squads:read'])
      expect(role.isSystem).toBe(false)
      expect(role.readOnly).toBe(false)
      expect(role.createdAt).toBeInstanceOf(Date)
      expect(role.updatedAt).toBeInstanceOf(Date)
    })

    it('creates a system read-only role', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `Test System Role ${slug}`,
        slug,
        permissions: ['*'],
        isSystem: true,
        readOnly: true,
      })

      expect(role.isSystem).toBe(true)
      expect(role.readOnly).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Role.findById
  // ---------------------------------------------------------------------------

  describe('Role.findById', () => {
    it('returns role by id', async () => {
      const slug = testSlug()
      const created = await Role.create({ name: `Test ${slug}`, slug, permissions: [] })
      const found = await Role.findById(created.id)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.slug).toBe(slug)
    })

    it('returns null for non-existent id', async () => {
      const found = await Role.findById('00000000-0000-0000-0000-000000000000')
      expect(found).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Role.findBySlug
  // ---------------------------------------------------------------------------

  describe('Role.findBySlug', () => {
    it('returns role by slug', async () => {
      const slug = testSlug()
      const created = await Role.create({ name: `Test ${slug}`, slug, permissions: [] })
      const found = await Role.findBySlug(slug)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
    })

    it('returns null for unknown slug', async () => {
      const found = await Role.findBySlug('nonexistent-slug-xyz')
      expect(found).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Role.findAll
  // ---------------------------------------------------------------------------

  describe('Role.findAll', () => {
    it('returns all roles including test roles', async () => {
      const slug1 = testSlug('-a')
      const slug2 = testSlug('-b')
      await Role.create({ name: `Test ${slug1}`, slug: slug1, permissions: [] })
      await Role.create({ name: `Test ${slug2}`, slug: slug2, permissions: [] })

      const all = await Role.findAll()
      const slugs = all.map((r) => r.slug)

      expect(slugs).toContain(slug1)
      expect(slugs).toContain(slug2)
    })
  })

  // ---------------------------------------------------------------------------
  // Role.update
  // ---------------------------------------------------------------------------

  describe('role.update', () => {
    it('updates permissions', async () => {
      const slug = testSlug()
      const role = await Role.create({ name: `Test ${slug}`, slug, permissions: ['agents:read'] })
      const updated = await role.update({ permissions: ['agents:read', 'squads:read'] })

      expect(updated.permissions).toEqual(['agents:read', 'squads:read'])
      expect(updated).toBe(role) // same instance
    })

    it('updates name', async () => {
      const slug = testSlug()
      const role = await Role.create({ name: `Test ${slug}`, slug, permissions: [] })
      await role.update({ name: `Updated ${slug}` })

      expect(role.name).toBe(`Updated ${slug}`)
    })

    it('throws when updating a readOnly role', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `ReadOnly ${slug}`,
        slug,
        permissions: ['*'],
        readOnly: true,
      })

      await expect(role.update({ permissions: ['agents:read'] })).rejects.toThrow(/read-only/i)
    })

    it('does not rename system roles or modify their permissions', async () => {
      const slug = testSlug()
      const originalName = `System ${slug}`
      const role = await Role.create({
        name: originalName,
        slug,
        permissions: ['agents:read'],
        isSystem: true,
        readOnly: false,
      })

      // Name is silently dropped for system roles
      await role.update({ name: 'New Name' })
      expect(role.name).toBe(originalName)

      // Permissions are protected for system roles
      await expect(role.update({ permissions: ['agents:read', 'squads:read'] })).rejects.toThrow(
        /Cannot modify permissions of system roles/
      )
      expect(role.permissions).toEqual(['agents:read'])
    })
  })

  // ---------------------------------------------------------------------------
  // Role.delete
  // ---------------------------------------------------------------------------

  describe('role.delete', () => {
    it('deletes a non-system non-readOnly role', async () => {
      const slug = testSlug()
      const role = await Role.create({ name: `Test ${slug}`, slug, permissions: [] })
      await role.delete()

      const found = await Role.findById(role.id)
      expect(found).toBeNull()
    })

    it('throws when deleting a readOnly role', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `ReadOnly ${slug}`,
        slug,
        permissions: [],
        readOnly: true,
      })

      await expect(role.delete()).rejects.toThrow(/read-only/i)
    })

    it('throws when deleting a system role', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `System ${slug}`,
        slug,
        permissions: [],
        isSystem: true,
        readOnly: false,
      })

      await expect(role.delete()).rejects.toThrow(/system/i)
    })
  })

  // ---------------------------------------------------------------------------
  // Role.readOnly getter
  // ---------------------------------------------------------------------------

  describe('role.readOnly', () => {
    it('returns false for regular roles', async () => {
      const slug = testSlug()
      const role = await Role.create({ name: `Test ${slug}`, slug, permissions: [] })
      expect(role.readOnly).toBe(false)
    })

    it('returns true for readOnly roles', async () => {
      const slug = testSlug()
      const role = await Role.create({ name: `ReadOnly ${slug}`, slug, permissions: [], readOnly: true })
      expect(role.readOnly).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Role.toJSON
  // ---------------------------------------------------------------------------

  describe('role.toJSON', () => {
    it('serializes to JSON', async () => {
      const slug = testSlug()
      const role = await Role.create({
        name: `Test ${slug}`,
        slug,
        permissions: ['agents:read'],
        isSystem: false,
        readOnly: false,
      })
      const json = role.toJSON()

      expect(json.id).toBe(role.id)
      expect(json.name).toBe(role.name)
      expect(json.slug).toBe(slug)
      expect(json.permissions).toEqual(['agents:read'])
      expect(json.isSystem).toBe(false)
      expect(json.readOnly).toBe(false)
      expect(typeof json.createdAt).toBe('string')
      expect(typeof json.updatedAt).toBe('string')
    })
  })
})
