import { LIVE_AGENT_STATUSES } from '@tau/shared'
import { sql } from 'drizzle-orm'
import { db } from '../../db'

export interface SquadDemandSnapshot {
  count: number
  firstDemandAt: Date | null
}

const liveAgentStatusSql = sql.join(
  [...LIVE_AGENT_STATUSES].map((status) => sql`${status}`),
  sql`, `
)

interface DemandRow extends Record<string, unknown> {
  squadId: string
  count: number | string
  firstDemandAt: Date | string | null
}

/**
 * Returns one bounded database snapshot for every active squad, including
 * explicit zero-demand entries. Demand is executable backlog, not merely a
 * row that exists in an operational table.
 */
export async function getSquadDemandSnapshots(input: { now: Date }): Promise<Map<string, SquadDemandSnapshot>> {
  const now = input.now.toISOString()
  const rows = await db.execute<DemandRow>(sql`
    WITH active_squads AS (
      SELECT id
      FROM squads
      WHERE status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM instance_maintenance_state AS maintenance
          WHERE maintenance.id = 'global'
            AND (
              maintenance.admin_hold = true
              OR maintenance.platform_lease_expires_at > ${now}::timestamptz
            )
        )
    ), demand AS (
      SELECT agent.squad_id, execution.started_at AS demanded_at
      FROM executions AS execution
      JOIN agents AS agent ON agent.id = execution.agent_id
      JOIN active_squads AS squad ON squad.id = agent.squad_id
      WHERE execution.status = 'queued'
        -- A TERMINATED agent can never serve its queued rows (pickup fails
        -- them on sight), so counting them as demand alerted eternally about
        -- work no live agent exists to run (the 2026-09-04 dead-fleet
        -- incident). A DORMANT agent stays counted: pickup wakes it for
        -- wake-eligible work, so its demand is genuine and must still alert.
        -- Executions whose agent row is gone are structurally excluded by the
        -- inner join — belt and braces for FK-bypassed orphan rows.
        AND agent.status <> 'terminated'

      UNION ALL

      SELECT agent.squad_id, message.created_at AS demanded_at
      FROM inbox AS message
      -- Cast the text side, not agents.id: a cast on the indexed side makes
      -- this unsargable and forces a sequential scan of the agents table.
      -- The regex guard cannot be dropped in favour of the recipient_type
      -- filter below: a hash join may evaluate this join condition on rows
      -- that filter would later reject, and recipient_id is the literal
      -- 'system' on those, which a bare cast would raise on.
      JOIN agents AS agent
        ON agent.id = (CASE WHEN message.recipient_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                            THEN message.recipient_id::uuid END)
      JOIN active_squads AS squad ON squad.id = agent.squad_id
      WHERE message.recipient_type = 'agent'
        AND message.read_at IS NULL
        AND message.delivered_at IS NULL
        -- Delivery leaves terminated recipients' inbox history untouched.
        -- Those messages cannot run, just like their queued executions above.
        AND agent.status <> 'terminated'

      UNION ALL

      SELECT CASE
          WHEN schedule.scope_type = 'agent' THEN scoped_agent.squad_id
          ELSE schedule.scope_id
        END AS squad_id,
        schedule.next_trigger_at AS demanded_at
      FROM schedules AS schedule
      LEFT JOIN agents AS scoped_agent
        ON schedule.scope_type = 'agent'
       AND scoped_agent.id = schedule.scope_id
      JOIN active_squads AS squad
        ON squad.id = CASE
          WHEN schedule.scope_type = 'agent' THEN scoped_agent.squad_id
          ELSE schedule.scope_id
        END
      WHERE schedule.enabled = true
        AND schedule.next_trigger_at IS NOT NULL
        AND schedule.next_trigger_at <= ${now}::timestamptz
        AND (
          (schedule.scope_type = 'agent' AND schedule.action->>'type' = 'inbox_message')
          OR
          (schedule.scope_type = 'squad' AND schedule.action->>'type' IN ('inbox_message', 'spawn_agent', 'create_work_stream'))
        )
        AND NOT (
          (
            schedule.action->>'type' = 'create_work_stream'
            OR (
              schedule.action->>'type' = 'spawn_agent'
              AND schedule.action->'workStream' IS NOT NULL
              AND schedule.action->'workStream' <> 'null'::jsonb
            )
          )
          AND schedule.schedule->>'skipIfUnresolved' IS DISTINCT FROM 'false'
          AND EXISTS (
            SELECT 1
            FROM work_streams AS prior
            WHERE prior.metadata->>'scheduleId' = schedule.id::text
              AND prior.status NOT IN ('done', 'canceled')
          )
        )

      UNION ALL

      SELECT stream.squad_id, stream.created_at AS demanded_at
      FROM work_streams AS stream
      JOIN active_squads AS squad ON squad.id = stream.squad_id
      WHERE stream.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM work_stream_waits AS wait
          WHERE wait.work_stream_id = stream.id
            AND wait.closed_at IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM agents AS participant
          WHERE participant.squad_id = stream.squad_id
            AND participant.status::text IN (${liveAgentStatusSql})
            AND (
              participant.id = stream.assignee_agent_id
              OR participant.id = ANY(COALESCE(stream.agent_ids, '{}'::uuid[]))
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM executions AS live_execution
          JOIN agents AS participant ON participant.id = live_execution.agent_id
          WHERE participant.squad_id = stream.squad_id
            AND (
              participant.id = stream.assignee_agent_id
              OR participant.id = ANY(COALESCE(stream.agent_ids, '{}'::uuid[]))
            )
            AND live_execution.status IN (
              'queued',
              'running',
              'stopping',
              'waiting-maintenance',
              'waiting-sandbox'
            )
        )
    ), aggregate_demand AS (
      SELECT squad_id, count(*)::integer AS count, min(demanded_at) AS first_demand_at
      FROM demand
      GROUP BY squad_id
    )
    SELECT squad.id AS "squadId",
      COALESCE(aggregate.count, 0)::integer AS count,
      aggregate.first_demand_at AS "firstDemandAt"
    FROM active_squads AS squad
    LEFT JOIN aggregate_demand AS aggregate ON aggregate.squad_id = squad.id
  `)

  return new Map(
    rows.map((row) => [
      row.squadId,
      {
        count: Number(row.count),
        firstDemandAt: row.firstDemandAt === null ? null : new Date(row.firstDemandAt),
      },
    ])
  )
}
