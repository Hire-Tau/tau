import type postgres from 'postgres'

/** Runs inside the migrator transaction, before installing the number default. */
export async function backfillWorkStreamNumbers(connection: postgres.ReservedSql): Promise<void> {
  await connection.unsafe('LOCK TABLE work_streams IN ACCESS EXCLUSIVE MODE')
  await connection.unsafe(`
    WITH numbered AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id)
        + (SELECT COALESCE(MAX(number), 0) FROM work_streams) AS number
      FROM work_streams WHERE number IS NULL
    )
    UPDATE work_streams w SET number = n.number FROM numbered n WHERE w.id = n.id
  `)
  // Never rewind: rolled-back inserts may already have consumed sequence values.
  await connection.unsafe(`
    SELECT setval('work_stream_number_seq',
      GREATEST((SELECT COALESCE(MAX(number), 0) FROM work_streams),
        (SELECT last_value FROM work_stream_number_seq)),
      (SELECT EXISTS (SELECT 1 FROM work_streams)) OR
        (SELECT is_called FROM work_stream_number_seq))
  `)
}
