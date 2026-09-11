import type postgres from 'postgres'

const DEFAULT_BATCH_SIZE = 500
const REPAIR_COMMAND = `SELECT setval('message_enqueue_order_seq',
  GREATEST((SELECT COALESCE(MAX(enqueue_order), 0) FROM messages), 1), true);`

type Stats = {
  null_count: string
  negative_count: string
  negative_distinct: string
  negative_min: string | null
  negative_max: string | null
}

async function hasNullEnqueueOrder(connection: postgres.ReservedSql): Promise<boolean> {
  const [row] = await connection.unsafe<{ has_null: boolean }[]>(
    'SELECT EXISTS (SELECT 1 FROM messages WHERE enqueue_order IS NULL LIMIT 1) AS has_null'
  )
  return row!.has_null
}

async function verifySequenceState(connection: postgres.ReservedSql): Promise<void> {
  const [state] = await connection.unsafe<{ max_positive: string; sequence_value: string }[]>(`
    SELECT COALESCE((
      SELECT enqueue_order FROM messages
      WHERE enqueue_order > 0
      ORDER BY enqueue_order DESC
      LIMIT 1
    ), 0)::text AS max_positive,
    (SELECT last_value::text FROM message_enqueue_order_seq) AS sequence_value
  `)
  if (BigInt(state!.sequence_value) < BigInt(state!.max_positive)) {
    throw new Error(`Message enqueue order sequence is behind stored rows. Quiesce writers and run:
${REPAIR_COMMAND}`)
  }
}

/** Assigns deterministic negative enqueue orders to pre-sequence message rows. */
export async function backfillMessageEnqueueOrder(
  connection: postgres.ReservedSql,
  options: { batchSize?: number } = {}
): Promise<{ updated: number; batches: number }> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('batchSize must be an integer between 1 and 10000')
  }

  if (!(await hasNullEnqueueOrder(connection))) {
    await verifySequenceState(connection)
    return { updated: 0, batches: 0 }
  }

  const [stats] = await connection.unsafe<Stats[]>(`
    SELECT count(*) FILTER (WHERE enqueue_order IS NULL)::text AS null_count,
      count(*) FILTER (WHERE enqueue_order < 0)::text AS negative_count,
      count(DISTINCT enqueue_order) FILTER (WHERE enqueue_order < 0)::text AS negative_distinct,
      min(enqueue_order) FILTER (WHERE enqueue_order < 0)::text AS negative_min,
      max(enqueue_order) FILTER (WHERE enqueue_order < 0)::text AS negative_max
    FROM messages
  `)
  const nullCount = Number(stats!.null_count)
  const negativeCount = Number(stats!.negative_count)
  const legacyTotal = nullCount + negativeCount
  if (negativeCount > 0) {
    const expectedMin = -legacyTotal
    const expectedMax = expectedMin + negativeCount - 1
    if (
      Number(stats!.negative_distinct) !== negativeCount ||
      Number(stats!.negative_min) !== expectedMin ||
      Number(stats!.negative_max) !== expectedMax
    ) {
      throw new Error('Existing negative message enqueue orders are not a contiguous partial backfill')
    }
  }

  let next = -legacyTotal + negativeCount
  let updated = 0
  let batches = 0
  while (true) {
    await connection.unsafe('BEGIN')
    try {
      const rows = await connection.unsafe<{ updated: string }[]>(`
        WITH locked AS MATERIALIZED (
          SELECT id, created_at
          FROM messages
          WHERE enqueue_order IS NULL
          ORDER BY created_at, id
          LIMIT ${batchSize}
          FOR UPDATE
        ), batch AS MATERIALIZED (
          SELECT id, row_number() OVER (ORDER BY created_at, id) - 1 AS ordinal
          FROM locked
        ), changed AS (
          UPDATE messages m
          SET enqueue_order = ${next} + batch.ordinal
          FROM batch
          WHERE m.id = batch.id AND m.enqueue_order IS NULL
          RETURNING m.id
        )
        SELECT count(*)::text AS updated FROM changed
      `)
      const count = Number(rows[0]!.updated)
      if (count === 0) {
        await connection.unsafe('COMMIT')
        break
      }
      await connection.unsafe('COMMIT')
      updated += count
      batches += 1
      next += count
    } catch (error) {
      await connection.unsafe('ROLLBACK')
      throw error
    }
  }

  if (await hasNullEnqueueOrder(connection)) {
    throw new Error('Message enqueue order backfill verification failed')
  }
  await verifySequenceState(connection)
  return { updated, batches }
}
