import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, users } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { InvalidAttachmentError, assertAttachmentInScope, resolveAttachmentScope } from './agent-scope'

const created: string[] = []

async function createAgent(parentAgentId?: string): Promise<Agent> {
  const [row] = await db.insert(agents).values({ agentTypeId: 'engineer', parentAgentId }).returning({ id: agents.id })
  created.push(row.id)
  return (await Agent.find(row.id))!
}

afterEach(async () => {
  if (created.length) await db.delete(agents).where(inArray(agents.id, created.splice(0)))
})

describe('attachment agent scope', () => {
  test('allows a target and its same-sandbox ancestors only', async () => {
    const ancestor = await createAgent()
    const parent = await createAgent(ancestor.id)
    const child = await createAgent(parent.id)
    const sibling = await createAgent(parent.id)

    const scope = await resolveAttachmentScope(child)
    expect(scope.ownerAgentIds).toEqual([child.id, parent.id, ancestor.id])
    expect(scope.sandboxId).toBe(await child.getSandboxId())
    expect(scope.ownerAgentIds).not.toContain(sibling.id)
  })

  test('does not grant upward or sibling access through physical sharing', async () => {
    const parent = await createAgent()
    const child = await createAgent(parent.id)
    const sibling = await createAgent(parent.id)
    const parentScope = await resolveAttachmentScope(parent)
    const siblingScope = await resolveAttachmentScope(sibling)

    expect(() => assertAttachmentInScope({ agentId: child.id, sandboxId: parentScope.sandboxId }, parentScope)).toThrow(
      InvalidAttachmentError
    )
    expect(() =>
      assertAttachmentInScope({ agentId: child.id, sandboxId: siblingScope.sandboxId }, siblingScope)
    ).toThrow(InvalidAttachmentError)
  })

  test('does not grant access between same-user co-located system managers', async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: `scope-${crypto.randomUUID()}@test.local`, displayName: 'Scope owner' })
      .returning()
    try {
      const rows = await db
        .insert(agents)
        .values([
          { agentTypeId: 'system-manager', ownerUserId: owner.id },
          { agentTypeId: 'system-manager', ownerUserId: owner.id },
        ])
        .returning({ id: agents.id })
      created.push(...rows.map(({ id }) => id))
      const first = (await Agent.find(rows[0].id))!
      const second = (await Agent.find(rows[1].id))!
      const scope = await resolveAttachmentScope(second)
      expect(await first.getSandboxId()).toBe(await second.getSandboxId())
      expect(scope.ownerAgentIds).not.toContain(first.id)
      expect(() => assertAttachmentInScope({ agentId: first.id, sandboxId: scope.sandboxId }, scope)).toThrow(
        InvalidAttachmentError
      )
    } finally {
      if (created.length) await db.delete(agents).where(inArray(agents.id, created.splice(0)))
      await db.delete(users).where(inArray(users.id, [owner.id]))
    }
  })

  test('rejects a stale sandbox binding with the same generic error', async () => {
    const target = await createAgent()
    const scope = await resolveAttachmentScope(target)
    expect(() => assertAttachmentInScope({ agentId: target.id, sandboxId: 'old-sandbox' }, scope)).toThrow(
      InvalidAttachmentError
    )
  })
})
