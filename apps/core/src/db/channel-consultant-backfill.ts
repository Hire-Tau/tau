import type postgres from 'postgres'

/** Frozen upgrade transform. Runs with the generated DDL and ledger in one transaction. */
export async function migrateChannelConsultants(connection: postgres.ReservedSql): Promise<void> {
  // Retain IDs, lifecycle state, provider threads, history, ownership and sandbox generations.
  await connection`UPDATE agents SET agent_type_id = 'consultant',
    context = CASE WHEN context #>> '{scope,type}' = 'concierge'
      THEN jsonb_set(context, '{scope,type}', '"consultant"'::jsonb) ELSE context END,
    updated_at = now() WHERE agent_type_id = 'concierge'`

  // Carry squad-specific instructions forward; retain both if each role was customized.
  await connection`UPDATE squads SET type_context = (type_context - 'concierge') ||
    jsonb_build_object('consultant', concat_ws(E'\n\n',
      nullif(type_context->>'consultant', ''), nullif(type_context->>'concierge', '')))
    WHERE type_context ? 'concierge'`
  await connection`DELETE FROM agent_types WHERE id = 'concierge'`

  // Agent permissions are derived from type, not role assignments. Preserve any exceptional
  // explicit grants as a custom role with exactly the old permissions, never as manager grants.
  await connection`DELETE FROM roles WHERE slug = 'default-concierge'
    AND NOT EXISTS (SELECT 1 FROM role_assignments WHERE role_id = roles.id)`
  await connection`UPDATE roles SET slug = 'migrated-channel-access-' || id::text,
    name = 'Migrated channel access ' || id::text, is_system = false, read_only = false,
    updated_by = 'migration', updated_at = now() WHERE slug = 'default-concierge'`
}

/** Preserve main's Assistant ownership backfill when regenerating its migration after channel linking. */
export async function migrateAssistantAgentBindings(connection: postgres.ReservedSql): Promise<void> {
  await connection`INSERT INTO assistant_conversation_agents (conversation_id, squad_id, agent_id)
    SELECT id, NULL, manager_agent_id FROM assistant_conversations WHERE manager_agent_id IS NOT NULL`
}
