import { db } from '../../db'
import { storedSecretToolAudits } from '../../db/schema'

export type StoredSecretToolAuditOutcome = 'denied' | 'already_executed'

export interface StoredSecretToolAuditInput {
  agentId: string
  executionId: string
  secretKey: string
  outcome: StoredSecretToolAuditOutcome
}

/**
 * Append one content-free stored-secret tool audit row.
 *
 * Projects exactly the four domain fields; never spreads the input, so no
 * caller-added property (value, payload, probe, ...) can reach the ledger.
 */
export async function recordStoredSecretToolAudit(input: StoredSecretToolAuditInput): Promise<void> {
  await db.insert(storedSecretToolAudits).values({
    agentId: input.agentId,
    executionId: input.executionId,
    secretKey: input.secretKey,
    outcome: input.outcome,
  })
}
