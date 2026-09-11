import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  permissionMatches,
  resolvePermissions,
  invalidatePermissionCache,
  hasPermission,
  hasAnyPermission,
  getAccessibleSquadIds,
  resolveRoleSummaries,
  type UserIdentity,
  type AgentIdentity,
} from './permissions'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../../test-utils'
import { db } from '../../db'
import { agents, agentTypes, squads, roles, roleAssignments, channelInstances, agentExtraScopes } from '../../db/schema'
import { like, eq, inArray } from 'drizzle-orm'
import { Squad } from '../../entities/Squad'
import { Agent } from '../../entities/Agent'

const PREFIX = 'perm-test'

async function cleanup() {
  // Clean up role assignments first (FK constraint)
  const testRoles = await db
    .select({ id: roles.id })
    .from(roles)
    .where(like(roles.slug, `${PREFIX}%`))
  for (const r of testRoles) {
    await db.delete(roleAssignments).where(eq(roleAssignments.roleId, r.id))
  }
  // Clean up assignments by subject
  await db.delete(roleAssignments).where(like(roleAssignments.subjectId, `${PREFIX}%`))
  await db.delete(channelInstances).where(like(channelInstances.id, `${PREFIX}%`))
  await cleanupTestRbac(PREFIX)
  await db.delete(squads).where(like(squads.name, `${PREFIX}%`))
}

// ── Unit Tests: permissionMatches ────────────────────────────────────────────

describe('permissionMatches', () => {
  test('global wildcard matches anything', () => {
    expect(permissionMatches('*', 'secrets:read')).toBe(true)
    expect(permissionMatches('*', 'agents:write:deploy')).toBe(true)
    expect(permissionMatches('*', '*')).toBe(true)
  })

  test('exact match', () => {
    expect(permissionMatches('secrets:read:integration', 'secrets:read:integration')).toBe(true)
  })

  test('exact match denial', () => {
    expect(permissionMatches('secrets:read', 'secrets:write')).toBe(false)
  })

  test('resource wildcard matches sub-permissions', () => {
    expect(permissionMatches('secrets:*', 'secrets:read')).toBe(true)
    expect(permissionMatches('secrets:*', 'secrets:write')).toBe(true)
    expect(permissionMatches('secrets:*', 'secrets:read:key:GITHUB_TOKEN')).toBe(true)
  })

  test('resource wildcard does not match other resources', () => {
    expect(permissionMatches('secrets:*', 'agents:read')).toBe(false)
  })

  test('bare grants qualified (prefix match)', () => {
    expect(permissionMatches('secrets:read', 'secrets:read:integration')).toBe(true)
    expect(permissionMatches('secrets:read', 'secrets:read:key:GITHUB_TOKEN')).toBe(true)
  })

  test('qualified does NOT grant bare', () => {
    expect(permissionMatches('secrets:read:integration', 'secrets:read')).toBe(false)
  })

  test('partial segment match does not work', () => {
    // "secrets:rea" should NOT match "secrets:read"
    expect(permissionMatches('secrets:rea', 'secrets:read')).toBe(false)
  })
})

// ── Integration Tests ────────────────────────────────────────────────────────

describe('resolvePermissions', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('legacy identity returns ["*"]', async () => {
    const perms = await resolvePermissions({ type: 'legacy' })
    expect(perms).toEqual(['*'])
  })

  test('user with system role gets those permissions', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({
      prefix: PREFIX,
      permissions: ['agents:read', 'agents:write'],
    })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const perms = await resolvePermissions({ type: 'user', userId: user.id })
    expect(perms).toContain('agents:read')
    expect(perms).toContain('agents:write')
  })

  test('union permissions from multiple roles', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role1 = await createTestRole({ prefix: PREFIX, permissions: ['agents:read'] })
    const role2 = await createTestRole({ prefix: PREFIX, permissions: ['secrets:read'] })
    await assignRole({ userId: user.id, roleId: role1.id, scope: 'system' })
    await assignRole({ userId: user.id, roleId: role2.id, scope: 'system' })

    const perms = await resolvePermissions({ type: 'user', userId: user.id })
    expect(perms).toContain('agents:read')
    expect(perms).toContain('secrets:read')
  })

  test('squad_default used when no squad override', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Squad Default`, purpose: 'test' })
      .returning()
    const role = await createTestRole({ prefix: PREFIX, permissions: ['squads:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad_default' })

    const perms = await resolvePermissions({ type: 'user', userId: user.id }, squad.id)
    expect(perms).toContain('squads:read')
  })

  test('squad override replaces squad_default (does NOT supplement)', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Squad Override`, purpose: 'test' })
      .returning()
    const defaultRole = await createTestRole({ prefix: PREFIX, permissions: ['squads:read', 'squads:update'] })
    const overrideRole = await createTestRole({ prefix: PREFIX, permissions: ['squads:read'] })

    await assignRole({ userId: user.id, roleId: defaultRole.id, scope: 'squad_default' })
    await assignRole({ userId: user.id, roleId: overrideRole.id, scope: 'squad', squadId: squad.id })

    const perms = await resolvePermissions({ type: 'user', userId: user.id }, squad.id)
    expect(perms).toContain('squads:read')
    expect(perms).not.toContain('squads:update') // Override replaces default
  })

  test('system + squad permissions are unioned', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Squad Union`, purpose: 'test' })
      .returning()
    const sysRole = await createTestRole({ prefix: PREFIX, permissions: ['system:admin'] })
    const squadRole = await createTestRole({ prefix: PREFIX, permissions: ['squads:deploy'] })

    await assignRole({ userId: user.id, roleId: sysRole.id, scope: 'system' })
    await assignRole({ userId: user.id, roleId: squadRole.id, scope: 'squad', squadId: squad.id })

    const perms = await resolvePermissions({ type: 'user', userId: user.id }, squad.id)
    expect(perms).toContain('system:admin')
    expect(perms).toContain('squads:deploy')
  })

  test('squad worker resolves via default-worker role', async () => {
    const defaultWorkerRole = await createTestRole({
      prefix: PREFIX,
      slug: 'default-worker',
      permissions: ['agents:read', 'chat:send'],
    })

    // Create a real agent (worker type) with a squad
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-worker-squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()

    const identity: AgentIdentity = {
      type: 'agent',
      agentId: agent.id,
      squadId: squad.id,
    }

    const perms = await resolvePermissions(identity)
    expect(perms).toContain('agents:read')
    expect(perms).toContain('chat:send')

    // Clean up
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(roles).where(eq(roles.slug, 'default-worker'))
  })

  test('subagent resolves via default-worker role', async () => {
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-worker',
      permissions: ['agents:read', 'chat:send'],
    })

    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-subagent-squad`, purpose: 'test' })
      .returning()
    const [parent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const [subagent] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId: squad.id, parentAgentId: parent.id })
      .returning()

    const perms = await resolvePermissions({
      type: 'agent',
      agentId: subagent.id,
      squadId: squad.id,
    })

    expect(perms).toContain('agents:read')
    expect(perms).toContain('chat:send')

    await db.delete(agents).where(inArray(agents.id, [subagent.id, parent.id]))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(roles).where(eq(roles.slug, 'default-worker'))
  })

  test('subagent inherits manager authority instead of the subagent worker default', async () => {
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-worker',
      permissions: ['deployments:write'],
    })
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-manager',
      permissions: ['workstreams:create'],
    })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-manager-child-squad`, purpose: 'test' })
      .returning()
    const [parent] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: squad.id }).returning()
    const [child] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId: squad.id, parentAgentId: parent.id })
      .returning()
    const identity: AgentIdentity = { type: 'agent', agentId: child.id, squadId: squad.id }

    expect(await hasPermission(identity, 'workstreams:create', squad.id)).toBe(true)
    expect(await hasPermission(identity, 'deployments:write', squad.id)).toBe(false)
    expect((await resolveRoleSummaries(identity, squad.id)).map((role) => role.slug)).toContain('default-manager')

    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, parent.id))
    expect(await hasPermission(identity, 'workstreams:create', squad.id)).toBe(false)
    expect(await resolveRoleSummaries(identity, squad.id)).toEqual([])
    expect(await getAccessibleSquadIds(identity)).toEqual([])

    await db.delete(agents).where(inArray(agents.id, [child.id, parent.id]))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(roles).where(inArray(roles.slug, ['default-worker', 'default-manager']))
  })

  test('subagent inherits concierge authority without child scope escalation', async () => {
    await createTestRole({ prefix: PREFIX, slug: 'default-worker', permissions: ['deployments:write'] })
    await createTestRole({ prefix: PREFIX, slug: 'default-concierge', permissions: ['workstreams:create'] })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-concierge-child-squad`, purpose: 'test' })
      .returning()
    const [parent] = await db.insert(agents).values({ agentTypeId: 'concierge', squadId: squad.id }).returning()
    const [child] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId: squad.id, parentAgentId: parent.id })
      .returning()
    await db.insert(agentExtraScopes).values({ agentId: child.id, permission: 'secrets:write' })
    const identity: AgentIdentity = { type: 'agent', agentId: child.id, squadId: squad.id }

    expect(await hasPermission(identity, 'workstreams:create', squad.id)).toBe(true)
    expect(await hasPermission(identity, 'deployments:write', squad.id)).toBe(false)
    expect(await hasPermission(identity, 'secrets:write', squad.id)).toBe(false)

    await db.delete(agentExtraScopes).where(eq(agentExtraScopes.agentId, child.id))
    await db.delete(agents).where(inArray(agents.id, [child.id, parent.id]))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(roles).where(inArray(roles.slug, ['default-worker', 'default-concierge']))
  })

  test('subagent authority fails closed for missing parents, cycles, and squad mismatches', async () => {
    await createTestRole({ prefix: PREFIX, slug: 'default-manager', permissions: ['workstreams:create'] })
    const [squadA, squadB] = await db
      .insert(squads)
      .values([
        { name: `${PREFIX}-authority-a`, purpose: 'test' },
        { name: `${PREFIX}-authority-b`, purpose: 'test' },
      ])
      .returning()
    const [parent] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: squadA.id }).returning()
    const [mismatch] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId: squadB.id, parentAgentId: parent.id })
      .returning()
    const [cycleA] = await db.insert(agents).values({ agentTypeId: 'subagent', squadId: squadA.id }).returning()
    const [cycleB] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId: squadA.id, parentAgentId: cycleA.id })
      .returning()
    await db.update(agents).set({ parentAgentId: cycleB.id }).where(eq(agents.id, cycleA.id))

    expect(
      await hasPermission({ type: 'agent', agentId: mismatch.id, squadId: squadB.id }, 'workstreams:create', squadB.id)
    ).toBe(false)
    expect(
      await hasPermission({ type: 'agent', agentId: cycleA.id, squadId: squadA.id }, 'workstreams:create', squadA.id)
    ).toBe(false)
    expect(await getAccessibleSquadIds({ type: 'agent', agentId: mismatch.id, squadId: squadB.id })).toEqual([])
    expect(await getAccessibleSquadIds({ type: 'agent', agentId: cycleA.id, squadId: squadA.id })).toEqual([])

    await db.delete(agents).where(inArray(agents.id, [cycleB.id, cycleA.id, mismatch.id, parent.id]))
    await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
    await db.delete(roles).where(eq(roles.slug, 'default-manager'))
  })

  test('squad manager resolves via default-manager role', async () => {
    const defaultManagerRole = await createTestRole({
      prefix: PREFIX,
      slug: 'default-manager',
      permissions: ['agents:read', 'agents:run', 'workstreams:manage-agents'],
    })

    // Create a real agent (manager type) with a squad
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-mgr-squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'manager', squadId: squad.id }).returning()

    const identity: AgentIdentity = {
      type: 'agent',
      agentId: agent.id,
      squadId: squad.id,
    }

    const perms = await resolvePermissions(identity)
    expect(perms).toContain('agents:read')
    expect(perms).toContain('agents:run')
    expect(perms).toContain('workstreams:manage-agents')

    // Clean up
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(roles).where(eq(roles.slug, 'default-manager'))
  })

  test('regular worker agent is denied role permissions for a squad it does not belong to', async () => {
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-worker',
      permissions: ['deployments:write', 'chat:send'],
    })

    const [ownSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-gated-own`, purpose: 'test' })
      .returning()
    const [otherSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-gated-other`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: ownSquad.id }).returning()

    const identity: AgentIdentity = { type: 'agent', agentId: agent.id, squadId: ownSquad.id }

    try {
      // Own squad: role permissions apply.
      expect(await hasPermission(identity, 'deployments:write', ownSquad.id)).toBe(true)
      // Unscoped check defaults to the agent's own squad.
      expect(await hasPermission(identity, 'deployments:write')).toBe(true)
      // Cross-squad must be DENIED (this is the cross-tenant IDOR fix).
      expect(await hasPermission(identity, 'deployments:write', otherSquad.id)).toBe(false)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(inArray(squads.id, [ownSquad.id, otherSquad.id]))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })

  test('system manager resolves via owning user (dynamic)', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['secrets:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const [manager] = await db
      .insert(agents)
      .values({ agentTypeId: 'system-manager', squadId: null, ownerUserId: user.id })
      .returning()
    const identity: AgentIdentity = {
      type: 'agent',
      agentId: manager.id,
      squadId: null,
      userId: user.id,
    }

    const perms = await resolvePermissions(identity)
    expect(perms).toContain('secrets:read')

    // Add another role to user — agent should see it immediately
    const role2 = await createTestRole({ prefix: PREFIX, permissions: ['agents:write'] })
    await assignRole({ userId: user.id, roleId: role2.id, scope: 'system' })

    const perms2 = await resolvePermissions(identity)
    expect(perms2).toContain('secrets:read')
    expect(perms2).toContain('agents:write')
  })
})

describe('agent extra scopes', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('extra scopes union with role permissions', async () => {
    await createTestRole({ prefix: PREFIX, slug: 'default-worker', permissions: ['agents:read', 'chat:send'] })
    const squad = await Squad.create({ name: `${PREFIX}-xs-union`, purpose: 'test' })
    const agent = await Agent.create({ agentTypeId: 'worker', squadId: squad.id })

    try {
      await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })

      const perms = await resolvePermissions({ type: 'agent', agentId: agent.id, squadId: squad.id }, squad.id)

      expect(perms).toContain('sandbox:logs')
      expect(perms).toContain('chat:send')
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })

  test('extra scopes do not bypass squad gate', async () => {
    await createTestRole({ prefix: PREFIX, slug: 'default-worker', permissions: ['agents:read', 'chat:send'] })
    const squad = await Squad.create({ name: `${PREFIX}-xs-gate-own`, purpose: 'test' })
    const other = await Squad.create({ name: `${PREFIX}-xs-gate-other`, purpose: 'test' })
    const agent = await Agent.create({ agentTypeId: 'worker', squadId: squad.id })

    try {
      await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })

      const perms = await resolvePermissions({ type: 'agent', agentId: agent.id, squadId: squad.id }, other.id)

      expect(perms).toEqual([])
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(inArray(squads.id, [squad.id, other.id]))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })

  test('extra scopes are ignored for system-manager user-backed agents', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['agents:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
    const agent = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: user.id })

    try {
      await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })

      const perms = await resolvePermissions({ type: 'agent', agentId: agent.id, squadId: null, userId: user.id })

      expect(perms).toContain('agents:read')
      expect(perms).not.toContain('sandbox:logs')
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  test('resolveRoleSummaries surfaces agent override entry', async () => {
    await createTestRole({ prefix: PREFIX, slug: 'default-worker', permissions: ['agents:read'] })
    const squad = await Squad.create({ name: `${PREFIX}-xs-summary`, purpose: 'test' })
    const agent = await Agent.create({ agentTypeId: 'worker', squadId: squad.id })

    try {
      await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'sandbox:logs' })

      const summaries = await resolveRoleSummaries({ type: 'agent', agentId: agent.id, squadId: squad.id }, squad.id)

      expect(summaries).toContainEqual(
        expect.objectContaining({
          slug: 'agent-override',
          source: 'agentOverride',
          permissions: ['sandbox:logs'],
        })
      )
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    }
  })
})

describe('hasPermission', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('checks permission with matching rules', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['secrets:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const identity: UserIdentity = { type: 'user', userId: user.id }

    expect(await hasPermission(identity, 'secrets:read')).toBe(true)
    expect(await hasPermission(identity, 'secrets:read:integration')).toBe(true) // bare grants qualified
    expect(await hasPermission(identity, 'secrets:write')).toBe(false)
  })

  test('wildcard permission grants everything', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['*'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const identity: UserIdentity = { type: 'user', userId: user.id }
    expect(await hasPermission(identity, 'anything:at:all')).toBe(true)
  })

  test('legacy identity has all permissions', async () => {
    expect(await hasPermission({ type: 'legacy' }, 'anything')).toBe(true)
  })

  test('hasAnyPermission ORs over candidates', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['secrets:read:integration'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const identity: UserIdentity = { type: 'user', userId: user.id }

    expect(await hasAnyPermission(identity, ['secrets:read', 'secrets:read:integration'])).toBe(true)
    expect(await hasAnyPermission(identity, ['secrets:read', 'secrets:read:system'])).toBe(false)
  })
})

describe('getAccessibleSquadIds', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('legacy identity returns "all"', async () => {
    expect(await getAccessibleSquadIds({ type: 'legacy' })).toBe('all')
  })

  test('user with system * returns "all"', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['*'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    expect(await getAccessibleSquadIds({ type: 'user', userId: user.id })).toBe('all')
  })

  test('user with squad_default returns "all"', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['squads:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad_default' })

    expect(await getAccessibleSquadIds({ type: 'user', userId: user.id })).toBe('all')
  })

  test('user with only squad-scoped assignments returns specific IDs', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const [squad1] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Accessible 1`, purpose: 'test' })
      .returning()
    const [squad2] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Accessible 2`, purpose: 'test' })
      .returning()
    const role = await createTestRole({ prefix: PREFIX, permissions: ['squads:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad1.id })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad2.id })

    const result = await getAccessibleSquadIds({ type: 'user', userId: user.id })
    expect(result).toBeInstanceOf(Array)
    expect(result).toContain(squad1.id)
    expect(result).toContain(squad2.id)
    expect((result as string[]).length).toBe(2)
  })

  test('agent with userId delegates to owning user', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['*'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const manager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: user.id })
    const identity: AgentIdentity = {
      type: 'agent',
      agentId: manager.id,
      squadId: null,
      userId: user.id,
    }

    expect(await getAccessibleSquadIds(identity)).toBe('all')
    await db.delete(agents).where(eq(agents.id, manager.id))
  })

  test('manager relationships do not grant resource access to the related squad', async () => {
    const own = await Squad.create({ name: `${PREFIX}-manager-own`, purpose: 'test' })
    const related = await Squad.create({ name: `${PREFIX}-manager-related`, purpose: 'test' })
    const manager = await Agent.create({ agentTypeId: 'manager', squadId: own.id })

    try {
      await own.addRelationship(related.id, 'collaborates')

      expect(
        await getAccessibleSquadIds({
          type: 'agent',
          agentId: manager.id,
          squadId: own.id,
        })
      ).toEqual([own.id])
    } finally {
      await db.delete(agents).where(eq(agents.id, manager.id))
      await db.delete(squads).where(inArray(squads.id, [own.id, related.id]))
    }
  })

  test('concierge returns only its own (single) squad', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX} Concierge Single Squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'concierge', squadId: squad.id }).returning()

    const result = await getAccessibleSquadIds({
      type: 'agent',
      agentId: agent.id,
      squadId: squad.id,
    })

    expect(result).toEqual([squad.id])
  })

  test('regular agent returns only its own squad', async () => {
    const squad = await Squad.create({ name: `${PREFIX}-regular-access`, purpose: 'test' })
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: squad.id })
    const identity: AgentIdentity = { type: 'agent', agentId: agent.id, squadId: squad.id }

    const result = await getAccessibleSquadIds(identity)
    expect(result).toEqual([squad.id])
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })
})

describe('duplicate role assignment', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('unique constraint rejects duplicate assignment', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const role = await createTestRole({ prefix: PREFIX, permissions: ['agents:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    // Second identical assignment should fail
    await expect(assignRole({ userId: user.id, roleId: role.id, scope: 'system' })).rejects.toThrow()
  })
})

// ── Security-path gap coverage ────────────────────────────────────────────────

describe('resolveAgentPermissions returns [] when no default role exists', () => {
  test('squad-agent identity with no default-worker or default-manager role returns []', async () => {
    // Ensure no default-worker or default-manager role exists
    await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    await db.delete(roles).where(eq(roles.slug, 'default-manager'))

    // Create a real squad and agent (worker type — not manager, not concierge, no userId/channelId)
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-no-default-role-squad`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()

    try {
      const identity: AgentIdentity = {
        type: 'agent',
        agentId: agent.id,
        squadId: squad.id,
        // no userId, no channelId → regular agent path
      }

      const perms = await resolvePermissions(identity)
      expect(perms).toEqual([])
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

// FIX 1: pin the roleless × extra_scopes branch.
// Prior to Task 13 the early-return fired on `agentRole.length === 0`, dropping all extra scopes.
// The new guard is `rolePermissions.length === 0 && extraScopes.length === 0`, so a roleless agent
// with extra_scopes must (a) receive them and (b) still be gated by squad-accessibility.
describe('roleless agent type with extra_scopes: granted when accessible, denied otherwise', () => {
  test('rolePermissions=[] + extraScopes=[amtp:send] → granted for own squad, denied for other', async () => {
    // Remove the role rows so the agent type's slug resolves to no permissions.
    await db.delete(roles).where(eq(roles.slug, 'default-worker'))
    await db.delete(roles).where(eq(roles.slug, 'default-manager'))

    const [ownSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-roleless-own`, purpose: 'test' })
      .returning()
    const [otherSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-roleless-other`, purpose: 'test' })
      .returning()

    const agentTypeId = `${PREFIX}-roleless-fed`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Roleless Fed Sender',
      model: 'openai-codex:gpt-5.6-sol:low',
      systemPrompt: 'test',
      extraScopes: ['amtp:send'],
    })

    const [agent] = await db.insert(agents).values({ agentTypeId, squadId: ownSquad.id }).returning()

    try {
      const identity: AgentIdentity = {
        type: 'agent',
        agentId: agent.id,
        squadId: ownSquad.id,
        // no userId → regular (non-system-manager) agent path
      }

      // rolePermissions is empty, but extraScopes=[amtp:send] → must pass squad gate and be granted.
      expect(await hasPermission(identity, 'amtp:send')).toBe(true)
      expect(await hasPermission(identity, 'amtp:send', ownSquad.id)).toBe(true)

      // Squad gate applies even for roleless agents: denied for a squad the agent is NOT accessible to.
      expect(await hasPermission(identity, 'amtp:send', otherSquad.id)).toBe(false)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      await db.delete(squads).where(inArray(squads.id, [ownSquad.id, otherSquad.id]))
    }
  })
})

describe('getAccessibleSquadIds fail-closed when authority is missing', () => {
  test('returns no squads when the agent does not exist in the database', async () => {
    const identity: AgentIdentity = {
      type: 'agent',
      agentId: '00000000-dead-beef-0000-000000000000',
      squadId: '00000000-dead-beef-0000-000000000001',
    }

    expect(await getAccessibleSquadIds(identity)).toEqual([])
  })
})

describe('consultant permissions', () => {
  test('grants a consultant the manager role permissions (workstreams:create)', async () => {
    // Idempotent upsert — does not DELETE the existing role; safe under any ordering.
    await createTestRole({
      prefix: PREFIX,
      slug: 'default-manager',
      permissions: ['workstreams:create', 'agents:read', 'agents:run'],
    })

    const squad = await Squad.create({ name: `${PREFIX}-sq`, purpose: 'test' })
    const consultant = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id })
    try {
      const allowed = await hasPermission(
        { type: 'agent', agentId: consultant.id, squadId: squad.id },
        'workstreams:create',
        squad.id
      )
      expect(allowed).toBe(true)
    } finally {
      await db.delete(agents).where(eq(agents.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-manager'))
    }
  })
})

// ── Task 13: agent_types extra_scopes ─────────────────────────────────────────

describe('agent_types extra_scopes grant amtp:send', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  test('agent of a type with scopes:[amtp:send] HAS it for an accessible squad and NOT for a non-accessible squad', async () => {
    const [ownSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-fed-own`, purpose: 'test' })
      .returning()
    const [otherSquad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-fed-other`, purpose: 'test' })
      .returning()

    const agentTypeId = `${PREFIX}-fed-sender`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Fed Sender',
      model: 'openai-codex:gpt-5.6-sol:low',
      systemPrompt: 'test',
      extraScopes: ['amtp:send'],
    })

    const [agent] = await db.insert(agents).values({ agentTypeId, squadId: ownSquad.id }).returning()

    try {
      const identity: AgentIdentity = {
        type: 'agent',
        agentId: agent.id,
        squadId: ownSquad.id,
        // no userId → regular (non-system-manager) agent path
      }

      // Accessible squad (its own) → granted, both unscoped (defaults to own squad) and explicit.
      expect(await hasPermission(identity, 'amtp:send')).toBe(true)
      expect(await hasPermission(identity, 'amtp:send', ownSquad.id)).toBe(true)

      // Non-accessible squad → denied: extra scopes are gated by squad-accessibility.
      expect(await hasPermission(identity, 'amtp:send', otherSquad.id)).toBe(false)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      await db.delete(squads).where(inArray(squads.id, [ownSquad.id, otherSquad.id]))
    }
  })

  // FIX 3 positive control: confirms that a REGULAR (non-system-manager) agent of an extra_scopes type
  // DOES receive amtp:send in its accessible squad. This makes the system-manager denial below
  // unambiguously due to the userId-bypass path and not a broken fixture.
  test('positive control: regular agent of an extra_scopes type gets amtp:send in its squad', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `${PREFIX}-fedposctl-own`, purpose: 'test' })
      .returning()

    const agentTypeId = `${PREFIX}-fed-posctl`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Fed Pos Ctl',
      model: 'openai-codex:gpt-5.6-sol:low',
      systemPrompt: 'test',
      extraScopes: ['amtp:send'],
    })
    const [agent] = await db.insert(agents).values({ agentTypeId, squadId: squad.id }).returning()

    try {
      const identity: AgentIdentity = {
        type: 'agent',
        agentId: agent.id,
        squadId: squad.id,
        // no userId → regular (non-system-manager) agent path
      }
      expect(await hasPermission(identity, 'amtp:send', squad.id)).toBe(true)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  test('a system-manager (identity.userId path) does NOT gain amtp:send via extra_scopes', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    // Owning user holds only an unrelated permission — never amtp:send.
    const role = await createTestRole({ prefix: PREFIX, permissions: ['squads:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    // The agent type DOES carry the extra scope, but the userId path resolves via the
    // owning user's roles and must ignore agent-type extra_scopes entirely.
    const agentTypeId = `${PREFIX}-fed-sysmgr`
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: 'Fed Sysmgr',
      model: 'openai-codex:gpt-5.6-sol:low',
      systemPrompt: 'test',
      extraScopes: ['amtp:send'],
    })
    const [agent] = await db.insert(agents).values({ agentTypeId, squadId: null, ownerUserId: user.id }).returning()

    try {
      const identity: AgentIdentity = {
        type: 'agent',
        agentId: agent.id,
        squadId: null,
        userId: user.id, // system-manager → resolve via owning user
      }
      expect(await hasPermission(identity, 'amtp:send')).toBe(false)
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    }
  })
})

describe('permission cache', () => {
  test('a repeat resolve within the TTL is served from cache; invalidatePermissionCache exposes new assignments', async () => {
    const user = await createTestUser({ prefix: `${PREFIX}-cache` })
    const role = await createTestRole({ permissions: ['agents:read'], prefix: `${PREFIX}-cache` })
    const identity = { type: 'user' as const, userId: user.id }
    invalidatePermissionCache()
    expect(await resolvePermissions(identity)).toEqual([])
    // A raw assignment write (no invalidation hook): the cached empty set is
    // still served — this is the bounded-staleness trade, not a bug.
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: user.id, roleId: role.id, scope: 'system' })
    expect(await resolvePermissions(identity)).toEqual([])
    invalidatePermissionCache()
    expect(await resolvePermissions(identity)).toEqual(['agents:read'])
    await cleanup()
  })
})
