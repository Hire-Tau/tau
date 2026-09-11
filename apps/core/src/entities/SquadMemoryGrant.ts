import { and, eq, gt, isNull, or, type InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { squadMemoryGrants } from '../db/schema'
import { parseSensitivity, type SensitivityTier } from '../services/memory/access/sensitivity'
import { IndexingService } from '../services/memory/indexer/IndexingService'

export interface GrantPolicyScope {
  sourceTypes?: string[]
  paths?: string[]
  sensitivity?: SensitivityTier
  sourceFilters?: Record<string, unknown>
}

export interface GrantPolicy {
  read?: GrantPolicyScope
  write?: Omit<GrantPolicyScope, 'sensitivity'>
}

export interface CreateSquadMemoryGrantInput {
  sourceSquadId: string
  granteeSquadId: string
  policy: GrantPolicy
  expiresAt?: Date | null
}

export type SquadMemoryGrantRow = InferSelectModel<typeof squadMemoryGrants>

function validStringArray(value: unknown): value is string[] {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function validateGrantPolicyScope(scope: GrantPolicyScope | undefined, allowSensitivity: boolean): string[] {
  if (!scope) return []
  const errors: string[] = []

  if (!validStringArray(scope.sourceTypes)) errors.push('sourceTypes must be an array of strings')
  if (!validStringArray(scope.paths)) errors.push('paths must be an array of strings')
  if (!allowSensitivity && scope.sensitivity !== undefined) errors.push('write policies cannot include sensitivity')
  if (allowSensitivity && scope.sensitivity && parseSensitivity(scope.sensitivity) !== scope.sensitivity) {
    errors.push(`invalid sensitivity: ${scope.sensitivity}`)
  }

  if (scope.sourceFilters !== undefined) {
    if (!scope.sourceFilters || typeof scope.sourceFilters !== 'object' || Array.isArray(scope.sourceFilters)) {
      errors.push('sourceFilters must be an object keyed by source type')
    } else {
      const indexer = IndexingService.instance()
      for (const [sourceType, filter] of Object.entries(scope.sourceFilters)) {
        const adapter = indexer.getAdapter(sourceType)
        if (!adapter) {
          errors.push(`unknown source filter source type: ${sourceType}`)
          continue
        }
        const filterErrors = adapter.validateGrantFilter?.(filter)
        if (filterErrors?.length) errors.push(...filterErrors.map((error) => `${sourceType}: ${error}`))
      }
    }
  }

  return errors
}

function assertValidGrantPolicy(policy: GrantPolicy): void {
  const errors = [
    ...validateGrantPolicyScope(policy.read, true),
    ...validateGrantPolicyScope(policy.write as GrantPolicyScope | undefined, false),
  ]
  if (errors.length > 0) throw new Error(`Invalid memory grant policy: ${errors.join('; ')}`)
}

export class SquadMemoryGrant {
  id: string
  sourceSquadId: string
  granteeSquadId: string
  policy: GrantPolicy
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date

  constructor(row: SquadMemoryGrantRow) {
    this.id = row.id
    this.sourceSquadId = row.sourceSquadId
    this.granteeSquadId = row.granteeSquadId
    this.policy = (row.policy as GrantPolicy) ?? {}
    this.expiresAt = row.expiresAt
    this.createdAt = row.createdAt
    this.updatedAt = row.updatedAt
  }

  static async create(input: CreateSquadMemoryGrantInput): Promise<SquadMemoryGrant> {
    assertValidGrantPolicy(input.policy)

    const [row] = await db
      .insert(squadMemoryGrants)
      .values({
        sourceSquadId: input.sourceSquadId,
        granteeSquadId: input.granteeSquadId,
        policy: input.policy,
        expiresAt: input.expiresAt ?? null,
      })
      .returning()
    return new SquadMemoryGrant(row)
  }

  static async find(id: string): Promise<SquadMemoryGrant | null> {
    const [row] = await db.select().from(squadMemoryGrants).where(eq(squadMemoryGrants.id, id)).limit(1)
    return row ? new SquadMemoryGrant(row) : null
  }

  static async findActiveByGrantee(granteeSquadId: string): Promise<SquadMemoryGrant[]> {
    const now = new Date()
    const rows = await db
      .select()
      .from(squadMemoryGrants)
      .where(
        and(
          eq(squadMemoryGrants.granteeSquadId, granteeSquadId),
          or(isNull(squadMemoryGrants.expiresAt), gt(squadMemoryGrants.expiresAt, now))
        )
      )
    return rows.map((row) => new SquadMemoryGrant(row))
  }

  static async listBySource(sourceSquadId: string): Promise<SquadMemoryGrant[]> {
    const rows = await db.select().from(squadMemoryGrants).where(eq(squadMemoryGrants.sourceSquadId, sourceSquadId))
    return rows.map((row) => new SquadMemoryGrant(row))
  }

  static async listByGrantee(granteeSquadId: string): Promise<SquadMemoryGrant[]> {
    const rows = await db.select().from(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, granteeSquadId))
    return rows.map((row) => new SquadMemoryGrant(row))
  }

  async delete(): Promise<void> {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.id, this.id))
  }
}
