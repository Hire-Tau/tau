import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { db } from './index'
import { squads, workStreams } from './schema'
import { createPostgresConnection, getConnectionString } from './connection'
import { backfillTrackedIssues } from './tracked-issue-backfill'

const prefix = `tracked-issue-backfill-${crypto.randomUUID()}`
let squadId: string

describe('tracked issue backfill', () => {
  beforeAll(async () => {
    squadId = (await db.insert(squads).values({ name: prefix, purpose: 'Backfill fixtures' }).returning())[0]!.id
  })

  afterAll(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  async function withConnection<T>(run: (connection: postgres.ReservedSql) => Promise<T>) {
    const client = createPostgresConnection(getConnectionString())
    const connection = await client.reserve()
    try {
      return await run(connection)
    } finally {
      connection.release()
      await client.end()
    }
  }

  async function insert(metadata: Record<string, unknown>) {
    const [row] = await db.insert(workStreams).values({ squadId, title: prefix, metadata }).returning()
    return row!.id
  }

  async function metadataOf(id: string) {
    const [row] = await db.select().from(workStreams).where(eq(workStreams.id, id))
    return row!.metadata as Record<string, any>
  }

  it('converts legacy github.issue rows once and leaves everything else alone', async () => {
    const connectionId = crypto.randomUUID()
    const stringIssue = await insert({
      github: { repo: `${prefix}/Widgets`, issue: '42', connectionId },
      codeHost: { integration: 'github', repository: `${prefix}/widgets` },
    })
    const numericIssue = await insert({ github: { repo: `${prefix}/tools`, issue: 7 } })
    const withOtherTracked = await insert({
      github: { repo: `${prefix}/tools`, issue: '8', connectionId },
      tracked: [{ integration: 'github', repository: `${prefix}/other`, kind: 'pull_request', number: 3 }],
    })
    const alreadyConverted = await insert({
      github: { repo: `${prefix}/tools`, issue: '9' },
      tracked: [{ integration: 'github', repository: `${prefix}/TOOLS`, kind: 'issue', number: 9, addedAt: 'earlier' }],
    })
    const untouched = await insert({ github: { repo: `${prefix}/tools`, pr: { number: 5 } }, tracked: [] })
    const untouchedBefore = await metadataOf(untouched)

    const first = await withConnection((connection) => backfillTrackedIssues(connection))
    expect(first.updated).toBeGreaterThanOrEqual(4)

    // The legacy pointer is gone; the identity now lives in `tracked`.
    const converted = await metadataOf(stringIssue)
    expect(converted.github).toEqual({ repo: `${prefix}/Widgets`, connectionId })
    expect(converted.codeHost).toEqual({ integration: 'github', repository: `${prefix}/widgets` })
    expect(converted.tracked).toHaveLength(1)
    expect(converted.tracked[0]).toMatchObject({
      integration: 'github',
      repository: `${prefix}/widgets`.toLowerCase(),
      kind: 'issue',
      number: 42,
      connectionId,
    })
    expect(typeof converted.tracked[0].addedAt).toBe('string')
    expect(new Date(converted.tracked[0].addedAt).toString()).not.toBe('Invalid Date')

    // A JSON number issue converts just like a string, and no connection is invented.
    const numeric = await metadataOf(numericIssue)
    expect(numeric.github).toEqual({ repo: `${prefix}/tools` })
    expect(numeric.tracked).toHaveLength(1)
    expect(numeric.tracked[0]).toMatchObject({ kind: 'issue', number: 7, repository: `${prefix}/tools` })
    expect(numeric.tracked[0].connectionId).toBeUndefined()

    // Existing links are preserved; the converted issue is appended.
    const merged = await metadataOf(withOtherTracked)
    expect(merged.github).toEqual({ repo: `${prefix}/tools`, connectionId })
    expect(merged.tracked.map((entry: any) => [entry.kind, entry.number])).toEqual([
      ['pull_request', 3],
      ['issue', 8],
    ])

    // An entry that already covers the legacy issue is not duplicated.
    const deduped = await metadataOf(alreadyConverted)
    expect(deduped.github).toEqual({ repo: `${prefix}/tools` })
    expect(deduped.tracked).toEqual([
      { integration: 'github', repository: `${prefix}/TOOLS`, kind: 'issue', number: 9, addedAt: 'earlier' },
    ])

    // Rows without a legacy issue are not rewritten at all.
    expect(await metadataOf(untouched)).toEqual(untouchedBefore)

    // Idempotent: a second startup finds nothing left to convert.
    const after = await Promise.all(
      [stringIssue, numericIssue, withOtherTracked, alreadyConverted, untouched].map(metadataOf)
    )
    const second = await withConnection((connection) => backfillTrackedIssues(connection))
    expect(second.updated).toBe(0)
    expect(
      await Promise.all([stringIssue, numericIssue, withOtherTracked, alreadyConverted, untouched].map(metadataOf))
    ).toEqual(after)
  })

  it('ignores rows whose github metadata cannot carry a legacy issue number', async () => {
    const rows = await Promise.all([
      insert({ github: [{ repo: `${prefix}/tools`, issue: '11' }] }),
      insert({ github: { issue: '12' } }),
      insert({ github: { repo: `${prefix}/tools`, issue: '0' } }),
      insert({ github: { repo: `${prefix}/tools`, issue: 'not-a-number' } }),
      insert({ github: { repo: `${prefix}/tools`, issue: null } }),
    ])
    const before = await Promise.all(rows.map(metadataOf))
    await withConnection((connection) => backfillTrackedIssues(connection))
    expect(await Promise.all(rows.map(metadataOf))).toEqual(before)
  })
})
