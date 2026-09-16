import type postgres from 'postgres'

/**
 * Frozen upgrade transform: conversations that already carry page-editor state were created by
 * the workflow builder before `kind` existed. Runs right after the column is added, inside the
 * migration transaction. Idempotent.
 */
export async function backfillAssistantConversationKinds(connection: postgres.ReservedSql): Promise<void> {
  await connection`UPDATE assistant_conversations SET kind = 'page-editor'
    WHERE editor IS NOT NULL AND kind <> 'page-editor'`
}
