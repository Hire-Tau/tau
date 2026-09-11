import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import { db, squadMemoryGrants, squads } from '../db'
import { SquadMemoryGrant } from '../entities/SquadMemoryGrant'
import { suggestSquadTool } from './suggest-squad'

async function cleanup(testPrefix: string): Promise<void> {
  await db.delete(squadMemoryGrants)
  await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
}

describe('suggest_squad tool', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `suggest-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await cleanup(testPrefix)
  })

  it('returns route with suggestions based on the caller squad scope', async () => {
    const [caller, billing] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'Intake.', status: 'active' },
        { name: `${testPrefix} Billing`, purpose: 'Refunds invoices chargebacks billing payments.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: billing.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })

    await expect(
      suggestSquadTool({ question: 'refund invoice chargeback' }, { squadId: caller.id })
    ).resolves.toMatchObject({
      recommendation: 'route',
      suggestions: expect.arrayContaining([expect.objectContaining({ squadId: billing.id })]),
    })
  })

  it('escalates when no candidate matches the request', async () => {
    const [caller] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Caller`, purpose: 'Refunds only.', status: 'active' })
      .returning()

    await expect(suggestSquadTool({ question: 'unrelated xyz qqq' }, { squadId: caller.id })).resolves.toMatchObject({
      recommendation: 'escalate',
      suggestions: [],
    })
  })
})
