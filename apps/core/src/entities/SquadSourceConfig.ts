import { and, eq, sql, type InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { squadSourceConfigs } from '../db/schema'
import type { BaseIngestionPolicy } from '../services/memory/sources/policy'

export interface UpsertSquadSourceConfigInput {
  squadId: string
  sourceType: string
  enabled?: boolean
  policy: BaseIngestionPolicy | Record<string, unknown>
}

export type SquadSourceConfigRow = InferSelectModel<typeof squadSourceConfigs>

export class SquadSourceConfig {
  id: string
  squadId: string
  sourceType: string
  enabled: boolean
  policy: Record<string, unknown>
  createdAt: Date
  updatedAt: Date

  constructor(row: SquadSourceConfigRow) {
    this.id = row.id
    this.squadId = row.squadId
    this.sourceType = row.sourceType
    this.enabled = row.enabled
    this.policy = (row.policy as Record<string, unknown>) ?? {}
    this.createdAt = row.createdAt
    this.updatedAt = row.updatedAt
  }

  static async upsert(input: UpsertSquadSourceConfigInput): Promise<SquadSourceConfig> {
    const now = new Date()
    const [row] = await db
      .insert(squadSourceConfigs)
      .values({
        squadId: input.squadId,
        sourceType: input.sourceType,
        enabled: input.enabled ?? true,
        policy: input.policy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [squadSourceConfigs.squadId, squadSourceConfigs.sourceType],
        set: {
          enabled: input.enabled ?? sql`${squadSourceConfigs.enabled}`,
          policy: input.policy,
          updatedAt: now,
        },
      })
      .returning()
    return new SquadSourceConfig(row)
  }

  static async findBySquadAndType(squadId: string, sourceType: string): Promise<SquadSourceConfig | null> {
    const [row] = await db
      .select()
      .from(squadSourceConfigs)
      .where(and(eq(squadSourceConfigs.squadId, squadId), eq(squadSourceConfigs.sourceType, sourceType)))
      .limit(1)
    return row ? new SquadSourceConfig(row) : null
  }

  static async listBySquad(squadId: string): Promise<SquadSourceConfig[]> {
    const rows = await db.select().from(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, squadId))
    return rows.map((row) => new SquadSourceConfig(row))
  }
}
