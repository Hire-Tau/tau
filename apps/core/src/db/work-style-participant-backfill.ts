import type postgres from 'postgres'

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function participant(value: unknown): unknown {
  if (!object(value) || typeof value.profile !== 'string') return value
  const { profile, ...settings } = value
  if (settings.agentTypeId !== undefined && settings.agentTypeId !== profile)
    throw new Error('Conflicting participant agent type during work-style migration')
  return { ...settings, agentTypeId: profile }
}

/** Frozen upgrade of flow-shaped JSON only; unrelated profile keys and prose remain untouched. */
export function upgradeWorkStyleParticipants(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(upgradeWorkStyleParticipants)
  if (!object(value)) return value
  const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, upgradeWorkStyleParticipants(item)]))
  if (value.schemaVersion === 1 && Array.isArray(value.steps) && object(value.participants)) {
    next.participants = Object.fromEntries(
      Object.entries(value.participants).map(([id, settings]) => [id, participant(settings)])
    )
  }
  if (
    value.op === 'put-participant' ||
    value.action === 'delegate' ||
    (typeof value.id === 'number' && object(value.step) && value.step.kind === 'agent')
  ) {
    if (object(value.participant)) next.participant = participant(value.participant)
  }
  return next
}

/** Runs in the generated column-rename transaction, including persisted editor drafts and queued commands. */
export async function migrateWorkStyleParticipants(connection: postgres.ReservedSql): Promise<void> {
  const targets = [
    ['work_styles', ['id'], ['definition', 'yaml_template']],
    ['squad_presets', ['id'], ['work_styles', 'yaml_template', 'schedule_templates']],
    ['squads', ['id'], ['metadata']],
    ['schedules', ['id'], ['action']],
    ['work_streams', ['id'], ['metadata']],
    ['work_stream_flow_runs', ['work_stream_id'], ['source', 'state']],
    ['work_stream_flow_transitions', ['work_stream_id', 'request_id'], ['command']],
    ['assistant_conversations', ['id'], ['editor']],
  ] as const
  for (const [table, keys, columns] of targets) {
    const rowKey = keys.map((key) => `${key}::text`).join(" || ':' || ")
    let cursor = ''
    while (true) {
      const rows = await connection.unsafe<(JsonObject & { row_id: string })[]>(
        `SELECT (${rowKey}) AS row_id, ${columns.join(',')} FROM ${table}
         WHERE (${rowKey}) > $1 ORDER BY (${rowKey}) LIMIT 250 FOR UPDATE`,
        [cursor]
      )
      if (!rows.length) break
      for (const row of rows) {
        for (const column of columns) {
          const next = upgradeWorkStyleParticipants(row[column])
          if (JSON.stringify(next) !== JSON.stringify(row[column]))
            await connection.unsafe(`UPDATE ${table} SET ${column}=$1::text::jsonb WHERE (${rowKey})=$2`, [
              next === null ? null : JSON.stringify(next),
              row.row_id,
            ])
        }
        cursor = row.row_id
      }
    }
  }
}
