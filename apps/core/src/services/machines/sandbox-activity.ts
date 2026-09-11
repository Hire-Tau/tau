import { sql } from 'drizzle-orm'
import { agents, db, executions } from '../../db'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import type { DbExecutor } from './force-migration-audit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SandboxActivity {
  active: boolean
  /** Count is absent when the sandbox owner cannot be derived safely. */
  activeExecutionCount?: number
}

async function ownerActivity(seedWhere: ReturnType<typeof sql>, executor: DbExecutor = db): Promise<SandboxActivity> {
  const rows = (await executor.execute(sql`
    WITH RECURSIVE owners AS (
      SELECT ${agents.id} AS id FROM ${agents} WHERE ${seedWhere}
      UNION
      SELECT a.id FROM ${agents} a JOIN owners o ON a.parent_agent_id = o.id
    )
    SELECT count(*)::int AS count FROM ${executions} e
    JOIN owners o ON e.agent_id = o.id
    WHERE e.status IN ('queued', 'waiting-sandbox', 'running', 'stopping')
  `)) as unknown as Array<{ count: number }>
  const activeExecutionCount = rows[0]?.count ?? 0
  return { active: activeExecutionCount > 0, activeExecutionCount }
}

/**
 * Resolve execution activity that can be using a sandbox. Unknown sandbox IDs
 * fail safe as active so destructive callers choose the longer grace tier.
 */
export async function sandboxActivity(sandboxId: string, executor: DbExecutor = db): Promise<SandboxActivity> {
  if (sandboxId.startsWith('system_manager_')) {
    const userId = sandboxId.slice('system_manager_'.length)
    if (!UUID_RE.test(userId)) return { active: true }
    return ownerActivity(sql`${agents.ownerUserId} = ${userId} AND ${agents.agentTypeId} = 'system-manager'`, executor)
  }

  if (sandboxId.startsWith('agent_')) {
    const agentId = sandboxId.slice('agent_'.length)
    if (!UUID_RE.test(agentId)) return { active: true }
    return ownerActivity(sql`${agents.id} = ${agentId}`, executor)
  }

  if (sandboxId.startsWith('squad_')) {
    const squadId = sandboxId.slice('squad_'.length)
    if (!UUID_RE.test(squadId)) return { active: true }
    const rows = (await executor.execute(sql`
      SELECT count(*)::int AS count FROM ${executions} e
      JOIN ${agents} a ON e.agent_id = a.id
      WHERE a.squad_id = ${squadId}
        AND (a.parent_agent_id IS NOT NULL OR a.agent_type_id NOT IN ('system-manager', ${ARTIFACT_BUILDER_AGENT_TYPE_ID}))
        AND e.status IN ('running', 'stopping')
    `)) as unknown as Array<{ count: number }>
    const activeExecutionCount = rows[0]?.count ?? 0
    return { active: activeExecutionCount > 0, activeExecutionCount }
  }

  return { active: true }
}

export async function sandboxHasActiveExecution(sandboxId: string, executor: DbExecutor = db): Promise<boolean> {
  return (await sandboxActivity(sandboxId, executor)).active
}
