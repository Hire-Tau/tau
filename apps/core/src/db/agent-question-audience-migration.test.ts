import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { MONOREPO_ROOT } from '../lib/paths'
import { reconcileAgentQuestionAttentionOnce } from '../services/agents/question-attention-reconciliation'
import { db } from './index'
import * as schema from './schema'
import { createPostgresConnection, getConnectionString } from './connection'
import { applyMigrations } from './migrator'

const migrations = readMigrationFiles({ migrationsFolder: join(MONOREPO_ROOT, 'apps/core/drizzle') })
const target = migrations.find((migration) => migration.sql.join('\n').includes('agent_question_recipients'))
const predecessors = target ? migrations.filter((migration) => migration.folderMillis < target.folderMillis) : []
const successors = target ? migrations.filter((migration) => migration.folderMillis > target.folderMillis) : []
const dbName = `agent_question_audience_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const rootSentinelTypeId = `${dbName}-root-sentinel`

function databaseUrl(name: string): string {
  const url = new URL(getConnectionString())
  url.pathname = `/${name}`
  return url.toString()
}

describe('agent question audience migration', () => {
  let admin: ReturnType<typeof createPostgresConnection>
  let client: ReturnType<typeof createPostgresConnection>
  let connection: postgres.ReservedSql
  let rootSentinelAgentId: string | undefined
  let rootSentinelQuestionId: string | undefined

  beforeAll(async () => {
    admin = createPostgresConnection(databaseUrl('postgres'), { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE DATABASE "${dbName}"`)
    client = createPostgresConnection(databaseUrl(dbName), { max: 1, onnotice: () => {} })
    connection = await client.reserve()
  })

  afterAll(async () => {
    if (rootSentinelQuestionId) {
      await db.delete(schema.agentQuestions).where(eq(schema.agentQuestions.id, rootSentinelQuestionId))
    }
    if (rootSentinelAgentId) await db.delete(schema.agents).where(eq(schema.agents.id, rootSentinelAgentId))
    await db.delete(schema.agentTypes).where(eq(schema.agentTypes.id, rootSentinelTypeId))
    connection?.release()
    await client?.end()
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
    await admin?.end()
  })

  it('preserves legacy rows while adding empty audience provenance tables', async () => {
    expect(target).toBeDefined()

    await applyMigrations(connection, predecessors)
    await connection.unsafe(`
      INSERT INTO agent_types (id, name, model, system_prompt)
      VALUES ('migration-agent', 'Migration agent', 'test:model', 'test')
    `)
    const [agent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id) VALUES ('migration-agent') RETURNING id
    `)
    const [user] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO users (email, display_name)
      VALUES ('migration-audience@example.com', 'Migration audience')
      RETURNING id
    `)
    const [pendingOnlyUser] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO users (email, display_name)
      VALUES ('migration-pending@example.com', 'Pending only')
      RETURNING id
    `)
    const [execution] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO executions (agent_id, status, started_at)
      VALUES ('${agent.id}', 'running', now() - interval '1 minute')
      RETURNING id
    `)
    const seeded = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(`
      INSERT INTO agent_questions (agent_id, question_data, status, answer, answered_at, created_at)
      VALUES
        ('${agent.id}', '{"questions":[]}'::jsonb, 'open', NULL, NULL, now()),
        ('${agent.id}', '{"questions":[]}'::jsonb, 'answered', 'done', now(), now())
      RETURNING id, status, answer
    `)
    const openQuestion = seeded.find((row) => row.status === 'open')!
    await connection.unsafe(`
      INSERT INTO messages (agent_id, role, content, pending, injected_at, metadata)
      VALUES
        (
          '${agent.id}', 'human', 'durably consumed participant', false, now(),
          jsonb_build_object(
            'source', 'user_chat',
            'sender', jsonb_build_object('userId', '${user.id}', 'name', 'Migration audience'),
            'executionId', '${execution.id}',
            'consumedAt', to_char(now() - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        ),
        (
          '${agent.id}', 'human', 'queued pending B', true, now(),
          jsonb_build_object(
            'source', 'user_chat',
            'sender', jsonb_build_object('userId', '${pendingOnlyUser.id}', 'name', 'Pending only'),
            'executionId', '${execution.id}'
          )
        ),
        (
          '${agent.id}', 'human', 'reset pending B', true, NULL,
          jsonb_build_object(
            'source', 'user_chat',
            'sender', jsonb_build_object('userId', '${pendingOnlyUser.id}', 'name', 'Pending only'),
            'executionId', '${execution.id}'
          )
        )
    `)

    const [squad] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO squads (name, purpose) VALUES ('Migration squad', 'Migration repair fixture') RETURNING id
    `)
    const [originSubscriber] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO users (email, display_name)
      VALUES ('migration-origin-subscriber@example.com', 'Origin subscriber')
      RETURNING id
    `)
    const [originAgent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id, squad_id) VALUES ('migration-agent', '${squad.id}') RETURNING id
    `)
    const [originStream] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO work_streams (squad_id, title, assignee_agent_id, agent_ids)
      VALUES ('${squad.id}', 'Exact legacy origin', '${originAgent.id}', ARRAY['${originAgent.id}'::uuid])
      RETURNING id
    `)
    const [originReaderRole] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO roles (name, slug, permissions)
      VALUES ('Migration origin reader', 'migration-origin-reader', '["actions:read"]'::jsonb)
      RETURNING id
    `)
    await connection.unsafe(`
      INSERT INTO role_assignments (subject_type, subject_id, role_id, scope, squad_id)
      VALUES ('user', '${originSubscriber.id}', '${originReaderRole.id}', 'squad', '${squad.id}');
      INSERT INTO work_stream_subscriptions (work_stream_id, user_id)
      VALUES ('${originStream.id}', '${originSubscriber.id}')
    `)
    const [originExecution] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO executions (agent_id, status, started_at)
      VALUES ('${originAgent.id}', 'running', now() - interval '1 minute')
      RETURNING id
    `)
    const [originQuestion] = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(`
      INSERT INTO agent_questions (agent_id, squad_id, question_data, status, created_at)
      VALUES ('${originAgent.id}', '${squad.id}', '{"questions":[]}'::jsonb, 'open', now())
      RETURNING id, status, answer
    `)
    await connection.unsafe(`
      INSERT INTO messages (agent_id, role, content, pending, metadata)
      VALUES (
        '${originAgent.id}', 'human', 'trusted legacy origin', false,
        jsonb_build_object(
          'source', 'work-stream-continuation',
          'workStreamId', '${originStream.id}',
          'executionId', '${originExecution.id}',
          'consumedAt', to_char(now() - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
      )
    `)

    const [ambiguousAgent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id) VALUES ('migration-agent') RETURNING id
    `)
    await connection.unsafe(`
      INSERT INTO executions (agent_id, status, started_at)
      VALUES
        ('${ambiguousAgent.id}', 'running', now() - interval '1 minute'),
        ('${ambiguousAgent.id}', 'running', now() - interval '1 minute')
    `)
    const [ambiguousQuestion] = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(`
      INSERT INTO agent_questions (agent_id, question_data, status)
      VALUES ('${ambiguousAgent.id}', '{"questions":[]}'::jsonb, 'open')
      RETURNING id, status, answer
    `)
    const [noSourceAgent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id) VALUES ('migration-agent') RETURNING id
    `)
    const [noSourceQuestion] = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(`
      INSERT INTO agent_questions (agent_id, question_data, status)
      VALUES ('${noSourceAgent.id}', '{"questions":[]}'::jsonb, 'open')
      RETURNING id, status, answer
    `)
    const legacyRows = [...seeded, originQuestion, ambiguousQuestion, noSourceQuestion]

    await applyMigrations(connection, target!)

    const preserved = await connection.unsafe<{ id: string; status: string; answer: string | null }[]>(
      `SELECT id, status, answer FROM agent_questions ORDER BY id`
    )
    expect([...preserved]).toEqual([...legacyRows].sort((left, right) => left.id.localeCompare(right.id)))
    expect(await connection.unsafe(`SELECT * FROM agent_question_recipients`)).toHaveLength(0)
    expect(await connection.unsafe(`SELECT * FROM agent_question_work_stream_origins`)).toHaveLength(0)

    await db.insert(schema.agentTypes).values({
      id: rootSentinelTypeId,
      name: rootSentinelTypeId,
      model: 'test:model',
      systemPrompt: 'test',
    })
    const [rootSentinelAgent] = await db
      .insert(schema.agents)
      .values({ agentTypeId: rootSentinelTypeId })
      .returning({ id: schema.agents.id })
    rootSentinelAgentId = rootSentinelAgent.id
    const [rootSentinelQuestion] = await db
      .insert(schema.agentQuestions)
      .values({ agentId: rootSentinelAgent.id, questionData: { questions: [] } })
      .returning({ id: schema.agentQuestions.id })
    rootSentinelQuestionId = rootSentinelQuestion.id

    // The repair service uses the current schema. Advance the scratch database only after
    // verifying the audience migration in isolation so later additive columns are available.
    await applyMigrations(connection, successors)

    const repairClient = createPostgresConnection(databaseUrl(dbName), { max: 1, onnotice: () => {} })
    try {
      const scratchDb = drizzle(repairClient, { schema }) as unknown as typeof db
      expect(await reconcileAgentQuestionAttentionOnce({ executor: scratchDb })).toMatchObject({
        processed: 4,
        resolved: 2,
        unresolved: 2,
      })
      expect(await reconcileAgentQuestionAttentionOnce({ executor: scratchDb })).toEqual({
        processed: 0,
        resolved: 0,
        unresolved: 0,
      })
      const [untouchedRootSentinel] = await db
        .select({ resolution: schema.agentQuestions.audienceResolution })
        .from(schema.agentQuestions)
        .where(eq(schema.agentQuestions.id, rootSentinelQuestion.id))
      expect(untouchedRootSentinel).toEqual({ resolution: null })
      const openRecipients = await connection.unsafe<{ user_id: string }[]>(
        `SELECT user_id FROM agent_question_recipients WHERE question_id = '${openQuestion.id}'`
      )
      expect([...openRecipients]).toEqual([{ user_id: user.id }])
      const originRecipients = await connection.unsafe<{ user_id: string }[]>(
        `SELECT user_id FROM agent_question_recipients WHERE question_id = '${originQuestion.id}'`
      )
      expect([...originRecipients]).toEqual([])
      const originResolution = await connection.unsafe<{ audience_resolution: string | null }[]>(
        `SELECT audience_resolution FROM agent_questions WHERE id = '${originQuestion.id}'`
      )
      expect([...originResolution]).toEqual([{ audience_resolution: 'resolved' }])
      const persistedOrigins = await connection.unsafe<{ work_stream_id: string }[]>(
        `SELECT work_stream_id FROM agent_question_work_stream_origins WHERE question_id = '${originQuestion.id}'`
      )
      expect([...persistedOrigins]).toEqual([{ work_stream_id: originStream.id }])
      const unresolved = await connection.unsafe<
        { id: string; audience_resolution: string; audience_alerted_at: Date | null }[]
      >(`
      SELECT id, audience_resolution, audience_alerted_at FROM agent_questions
      WHERE id IN ('${ambiguousQuestion.id}', '${noSourceQuestion.id}')
      ORDER BY id
    `)
      expect(unresolved).toHaveLength(2)
      expect(unresolved.every((row) => row.audience_resolution === 'legacy-unresolved')).toBe(true)
      // The unroutable-audience system-inbox notice is removed: the retained
      // audience_alerted_at column is never stamped.
      expect(unresolved.every((row) => row.audience_alerted_at === null)).toBe(true)

      const [unroutableAgent] = await connection.unsafe<{ id: string }[]>(`
      INSERT INTO agents (agent_type_id) VALUES ('migration-agent') RETURNING id
    `)
      await connection.unsafe(`
      INSERT INTO agent_questions (agent_id, question_data, status)
      VALUES ('${unroutableAgent.id}', '{"questions":[]}'::jsonb, 'open')
    `)
      expect(await reconcileAgentQuestionAttentionOnce({ executor: scratchDb })).toMatchObject({
        processed: 1,
        resolved: 0,
        unresolved: 1,
      })
    } finally {
      await repairClient.end()
      await db.delete(schema.agentQuestions).where(eq(schema.agentQuestions.id, rootSentinelQuestion.id))
      await db.delete(schema.agents).where(eq(schema.agents.id, rootSentinelAgent.id))
      await db.delete(schema.agentTypes).where(eq(schema.agentTypes.id, rootSentinelTypeId))
      rootSentinelQuestionId = undefined
      rootSentinelAgentId = undefined
    }

    expect(
      await db.select().from(schema.agentQuestions).where(eq(schema.agentQuestions.id, rootSentinelQuestion.id))
    ).toHaveLength(0)
    expect(await db.select().from(schema.agents).where(eq(schema.agents.id, rootSentinelAgent.id))).toHaveLength(0)
    expect(await db.select().from(schema.agentTypes).where(eq(schema.agentTypes.id, rootSentinelTypeId))).toHaveLength(
      0
    )

    const columns = await connection.unsafe<{ column_name: string }[]>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agent_questions'
        AND column_name IN ('execution_id', 'audience_resolution', 'audience_resolved_at', 'audience_alerted_at')
      ORDER BY column_name
    `)
    expect(columns.map((column) => column.column_name)).toEqual([
      'audience_alerted_at',
      'audience_resolution',
      'audience_resolved_at',
      'execution_id',
    ])

    const constraints = await connection.unsafe<{ table_name: string; constraint_type: string }[]>(`
      SELECT table_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name IN ('agent_question_recipients', 'agent_question_work_stream_origins')
        AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
      ORDER BY table_name, constraint_type
    `)
    expect([...constraints]).toEqual([
      { table_name: 'agent_question_recipients', constraint_type: 'FOREIGN KEY' },
      { table_name: 'agent_question_recipients', constraint_type: 'FOREIGN KEY' },
      { table_name: 'agent_question_recipients', constraint_type: 'PRIMARY KEY' },
      { table_name: 'agent_question_work_stream_origins', constraint_type: 'FOREIGN KEY' },
      { table_name: 'agent_question_work_stream_origins', constraint_type: 'FOREIGN KEY' },
      { table_name: 'agent_question_work_stream_origins', constraint_type: 'PRIMARY KEY' },
    ])

    const indexes = await connection.unsafe<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'idx_agent_question_recipients_user_question',
        'idx_agent_question_origins_stream_question'
      ) ORDER BY indexname
    `)
    expect(indexes.map((index) => index.indexname)).toEqual([
      'idx_agent_question_origins_stream_question',
      'idx_agent_question_recipients_user_question',
    ])
  }, 240_000)
})
