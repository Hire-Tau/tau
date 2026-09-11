import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import { db, memoryDocuments, squadMemoryGrants, squads } from '../../db'
import { SquadMemoryGrant } from '../../entities/SquadMemoryGrant'
import { IndexingService } from '../memory/indexer/IndexingService'
import {
  gatherCandidateSquadIds,
  scoreKeywordOverlap,
  suggestSquad,
  suggestSquadWithRecommendation,
} from './squad-suggester'

async function cleanupRoutingTestData(testPrefix: string): Promise<void> {
  await db.delete(squadMemoryGrants)
  await db.delete(memoryDocuments).where(like(memoryDocuments.path, `/memory/ownership/${testPrefix}-%`))
  await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
}

describe('scoreKeywordOverlap', () => {
  it('returns 0 when there is no overlap', () => {
    expect(scoreKeywordOverlap('deploy the billing service', 'frontend design system')).toBe(0)
  })

  it('scores proportional to matched distinct terms', () => {
    const score = scoreKeywordOverlap('billing invoice refund', 'the billing and invoice squad')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
    expect(score).toBeCloseTo(2 / 3, 5)
  })

  it('is case-insensitive and ignores short tokens', () => {
    expect(scoreKeywordOverlap('AUTH on by', 'auth service')).toBeCloseTo(1, 5)
  })
})

describe('gatherCandidateSquadIds', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `routing-candidates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await cleanupRoutingTestData(testPrefix)
  })

  it('returns only the caller squad when there are no grants', async () => {
    const [caller] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Engineering`, purpose: 'Engineering', status: 'active' },
        { name: `${testPrefix} Unrelated`, purpose: 'Unrelated', status: 'active' },
      ])
      .returning()

    const ids = await gatherCandidateSquadIds(caller.id)
    expect(ids).toEqual([caller.id])
  })

  it('includes squads the caller has an inbound read grant from', async () => {
    const [core, engineering] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Core`, purpose: 'Core', status: 'active' },
        { name: `${testPrefix} Engineering`, purpose: 'Engineering', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: core.id,
      granteeSquadId: engineering.id,
      policy: { read: { sensitivity: 'internal' } },
    })

    const ids = await gatherCandidateSquadIds(engineering.id)
    expect(ids.sort()).toEqual([core.id, engineering.id].sort())
  })
})

describe('suggestSquad', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `routing-suggest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await cleanupRoutingTestData(testPrefix)
  })

  it('ranks the squad whose purpose matches the question first', async () => {
    const [billing, frontend] = await db
      .insert(squads)
      .values([
        {
          name: `${testPrefix} Billing`,
          purpose: 'Owns invoicing, refunds, and payment processing.',
          status: 'active',
        },
        {
          name: `${testPrefix} Frontend`,
          purpose: 'Owns the web design system and UI components.',
          status: 'active',
        },
      ])
      .returning()

    const suggestions = await suggestSquad(billing.id, 'a customer wants a refund on a duplicate invoice', {
      limit: 5,
    })

    expect(suggestions[0].squadId).toBe(billing.id)
    expect(suggestions[0].score).toBeGreaterThan(0)
    expect(suggestions[0].reasons.some((reason) => reason.toLowerCase().includes('purpose'))).toBe(true)
    expect(suggestions.find((suggestion) => suggestion.squadId === frontend.id)).toBeUndefined()
  })

  it('surfaces ownership frontmatter on search results for routing', async () => {
    const [caller, billing] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'Intake routing.', status: 'active' },
        { name: `${testPrefix} Billing`, purpose: 'Sparse.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: billing.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })
    await IndexingService.instance().indexFile({
      squadId: billing.id,
      path: `/memory/ownership/${testPrefix}-billing.md`,
      content: `---\nkind: ownership\ntitle: Billing ownership\nsquadIds: ["${billing.id}"]\n---\n\nBilling squad owns refunds.`,
    })

    const { SearchService } = await import('../memory/SearchService')
    const [hit] = await SearchService.instance().search(caller.id, 'refunds', {
      paths: ['/memory/ownership/**'],
      limit: 1,
    })

    expect(hit.frontmatter?.kind).toBe('ownership')
    expect(hit.frontmatter?.squadIds).toEqual([billing.id])
  })

  it('boosts a squad whose id appears in a matching ownership doc, even with sparse purpose', async () => {
    const [caller, billing] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'Intake routing.', status: 'active' },
        { name: `${testPrefix} Squad B`, purpose: '', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: billing.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })
    await IndexingService.instance().indexFile({
      squadId: caller.id,
      path: `/memory/ownership/${testPrefix}-billing.md`,
      content: `---\nkind: ownership\ntitle: Billing ownership\nsquadIds: ["${billing.id}"]\n---\n\nThe Billing squad owns refunds.`,
    })

    const [top] = await suggestSquad(caller.id, 'refund question', { limit: 5 })

    expect(top.squadId).toBe(billing.id)
    expect(top.evidence.some((e) => e.kind === 'ownership' && e.source?.path?.includes('billing'))).toBe(true)
  })

  it('boosts a granted squad when an ownership doc matches', async () => {
    const [core, support] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Core`, purpose: 'Company memory.', status: 'active' },
        { name: `${testPrefix} Support`, purpose: 'General help.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: core.id,
      granteeSquadId: support.id,
      policy: { read: { sensitivity: 'internal' } },
    })
    await IndexingService.instance().indexFile({
      squadId: core.id,
      path: `/memory/ownership/${testPrefix}-billing.md`,
      content: `---\ntitle: Billing ownership\nkind: ownership\n---\n\nThe Billing squad owns refunds, chargebacks, and invoice disputes.`,
    })

    const suggestions = await suggestSquad(support.id, 'who handles chargebacks and invoice disputes?', { limit: 5 })

    const coreSuggestion = suggestions.find((suggestion) => suggestion.squadId === core.id)
    expect(coreSuggestion).toBeDefined()
    expect(coreSuggestion!.reasons.some((reason) => reason.toLowerCase().includes('ownership'))).toBe(true)
  })
})

describe('suggestSquadWithRecommendation', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `routing-recommend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await cleanupRoutingTestData(testPrefix)
  })

  it('recommends route when one suggestion clearly leads', async () => {
    const [billing] = await db
      .insert(squads)
      .values({
        name: `${testPrefix} Billing`,
        purpose: 'Refunds invoices chargebacks billing payments.',
        status: 'active',
      })
      .returning()

    const res = await suggestSquadWithRecommendation(billing.id, 'refund invoice chargeback', { limit: 5 })

    expect(res.recommendation).toBe('route')
    expect(res.confidence).toBeGreaterThan(0.25)
    expect(res.suggestions[0].squadId).toBe(billing.id)
  })

  it('recommends clarify when top two suggestions are close', async () => {
    const [caller, frontend] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Frontend A`, purpose: 'Frontend UI components design system.', status: 'active' },
        { name: `${testPrefix} Frontend B`, purpose: 'Frontend UI components design system.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: frontend.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })

    const res = await suggestSquadWithRecommendation(caller.id, 'frontend UI components', { limit: 5 })

    expect(res.recommendation).toBe('clarify')
  })

  it('recommends escalate when there are no usable candidates', async () => {
    const [caller] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Caller`, purpose: 'Refunds only.', status: 'active' })
      .returning()

    const res = await suggestSquadWithRecommendation(caller.id, 'unrelated xyz qqq', { limit: 5 })

    expect(res.recommendation).toBe('escalate')
    expect(res.confidence).toBe(0)
  })
})

describe('suggestSquad evidence shape', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `routing-evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await cleanupRoutingTestData(testPrefix)
  })

  it('returns structured evidence with source paths when memory and ownership hits exist', async () => {
    const [caller, billing] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'Intake routing.', status: 'active' },
        { name: `${testPrefix} Billing`, purpose: 'Refunds, chargebacks, invoices.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: billing.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })
    await IndexingService.instance().indexFile({
      squadId: billing.id,
      path: `/memory/ownership/${testPrefix}-billing.md`,
      content: `---\nkind: ownership\ndomain: billing\nsquadIds: ["${billing.id}"]\n---\n\nBilling squad owns refunds and chargebacks.`,
    })

    const [top] = await suggestSquad(caller.id, 'refund chargeback question', { limit: 5 })

    expect(top.squadId).toBe(billing.id)
    expect(top.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'purpose', score: expect.any(Number) }),
        expect.objectContaining({
          kind: 'ownership',
          score: expect.any(Number),
          source: expect.objectContaining({
            sourceType: 'memory_file',
            sourceSquadId: billing.id,
            path: expect.stringContaining('/memory/ownership/'),
          }),
        }),
      ])
    )
  })

  it('preserves a textual reasons field for backwards compatibility', async () => {
    const [caller, billing] = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'Intake routing.', status: 'active' },
        { name: `${testPrefix} Billing`, purpose: 'Refunds and invoices.', status: 'active' },
      ])
      .returning()
    await SquadMemoryGrant.create({
      sourceSquadId: billing.id,
      granteeSquadId: caller.id,
      policy: { read: { sensitivity: 'internal' } },
    })

    const [top] = await suggestSquad(caller.id, 'refund question', { limit: 5 })

    expect(top.reasons).toEqual(expect.arrayContaining([expect.stringContaining('Squad purpose matches')]))
  })
})
