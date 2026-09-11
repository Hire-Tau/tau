import { profileFingerprint } from './agent-expertise-backfill'
import type postgres from 'postgres'

/** Frozen upgrade: provenance replaces live inheritance before the generated rename/drop DDL. */
export async function detachSquadPresets(connection: postgres.ReservedSql): Promise<void> {
  // Preserve squad-owned choices. Only fill defaults that previously came from the type.
  await connection.unsafe(`
    UPDATE squads s SET
      metadata = COALESCE(s.metadata, '{}'::jsonb)
        || jsonb_build_object('workStyle', COALESCE(NULLIF(s.metadata->'workStyle', 'null'::jsonb),
             NULLIF(t.work_styles->'default', 'null'::jsonb), '{"kind":"preset","id":"solo","customizations":[]}'::jsonb))
        || CASE WHEN t.work_styles IS NOT NULL AND NULLIF(s.metadata->'workStyleSetup','null'::jsonb) IS NULL
           THEN jsonb_build_object('workStyleSetup',jsonb_build_object('guidance',COALESCE(t.work_styles->'guidance','""'::jsonb),'choices',COALESCE(t.work_styles->'choices','[]'::jsonb)))
           ELSE '{}'::jsonb END,
      type_context = CASE WHEN NULLIF(btrim(t.manager_instructions),'') IS NULL THEN s.type_context
        ELSE COALESCE(s.type_context,'{}'::jsonb) || jsonb_build_object('manager',
          CASE WHEN strpos(COALESCE(s.type_context->>'manager',''),t.manager_instructions)>0
            THEN s.type_context->>'manager'
            ELSE concat_ws(E'\\n\\n', t.manager_instructions, NULLIF(s.type_context->>'manager','')) END) END
    FROM squad_types t WHERE s.squad_type_id=t.id;
    UPDATE squads SET metadata=COALESCE(metadata,'{}'::jsonb) ||
      '{"workStyle":{"kind":"preset","id":"solo","customizations":[]}}'::jsonb
      WHERE NULLIF(metadata->'workStyle','null'::jsonb) IS NULL;
    UPDATE squad_types SET yaml_template=yaml_template-'workerInstructions',
      yaml_field_overrides=COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(yaml_field_overrides) value
        WHERE value <> '"workerInstructions"'::jsonb),'[]'::jsonb);
  `)

  // Rename persisted grants rather than leaving valid administrators/tokens without access.
  const permission = (value: string) => value.replace(/^squad-types:/, 'squad-presets:')
  for (const [table, column] of [
    ['roles', 'permissions'],
    ['system_tokens', 'scopes'],
  ] as const) {
    const rows = await connection.unsafe<{ id: string; grants: string[] }[]>(
      `SELECT id, ${column} AS grants FROM ${table} FOR UPDATE`
    )
    for (const row of rows) {
      const next = [...new Set(row.grants.map(permission))]
      if (JSON.stringify(next) === JSON.stringify(row.grants)) continue
      await connection.unsafe(`UPDATE ${table} SET ${column}=$1::text::jsonb WHERE id=$2`, [
        JSON.stringify(next),
        row.id,
      ])
    }
  }
  await connection.unsafe(`
    DELETE FROM agent_extra_scopes old USING agent_extra_scopes current
      WHERE old.agent_id=current.agent_id AND old.permission LIKE 'squad-types:%'
      AND current.permission=regexp_replace(old.permission,'^squad-types:','squad-presets:');
    UPDATE agent_extra_scopes SET permission=regexp_replace(permission,'^squad-types:','squad-presets:')
      WHERE permission LIKE 'squad-types:%';
    UPDATE skills SET required_permission=regexp_replace(required_permission,'^squad-types:','squad-presets:')
      WHERE required_permission LIKE 'squad-types:%';
    UPDATE agent_types SET extra_scopes=ARRAY(SELECT DISTINCT regexp_replace(scope,'^squad-types:','squad-presets:') FROM unnest(extra_scopes) scope)
      WHERE EXISTS(SELECT 1 FROM unnest(extra_scopes) scope WHERE scope LIKE 'squad-types:%');
    UPDATE agent_types SET yaml_template=jsonb_set(yaml_template,'{extraScopes}',
      (SELECT jsonb_agg(regexp_replace(value,'^squad-types:','squad-presets:')) FROM jsonb_array_elements_text(yaml_template->'extraScopes')))
      WHERE jsonb_typeof(yaml_template->'extraScopes')='array' AND yaml_template->'extraScopes' <> '[]'::jsonb;
  `)
  const profile = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...value,
    ...(Array.isArray(value.extraScopes)
      ? {
          extraScopes: [
            ...new Set(value.extraScopes.map((scope) => (typeof scope === 'string' ? permission(scope) : scope))),
          ],
        }
      : {}),
  })
  let cursor = ''
  while (true) {
    const rows = await connection<{ work_stream_id: string; profiles: Record<string, Record<string, unknown>> }[]>`
      SELECT work_stream_id,profiles FROM work_stream_flow_runs WHERE work_stream_id::text>${cursor}
      ORDER BY work_stream_id LIMIT 250 FOR UPDATE`
    if (!rows.length) break
    for (const row of rows) {
      const next = Object.fromEntries(Object.entries(row.profiles).map(([key, value]) => [key, profile(value)]))
      if (JSON.stringify(next) !== JSON.stringify(row.profiles))
        await connection`UPDATE work_stream_flow_runs SET profiles=${JSON.stringify(next)}::text::jsonb WHERE work_stream_id=${row.work_stream_id}`
      cursor = row.work_stream_id
    }
  }
  cursor = ''
  while (true) {
    const rows = await connection<{ agent_id: string; binding_key: string; profile: Record<string, unknown> }[]>`
      SELECT agent_id,binding_key,profile FROM work_style_bindings WHERE agent_id::text>${cursor}
      ORDER BY agent_id LIMIT 250 FOR UPDATE`
    if (!rows.length) break
    for (const row of rows) {
      const next = profile(row.profile)
      if (JSON.stringify(next) !== JSON.stringify(row.profile)) {
        const key = row.binding_key.replace(profileFingerprint(row.profile), profileFingerprint(next))
        await connection`UPDATE work_style_bindings SET profile=${JSON.stringify(next)}::text::jsonb,binding_key=${key} WHERE agent_id=${row.agent_id}`
      }
      cursor = row.agent_id
    }
  }
}
