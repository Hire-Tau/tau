import { and, eq, isNull, or } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { amtpAllowRules } from '../db/schema'

export type AmtpAllowRuleRow = InferSelectModel<typeof amtpAllowRules>

export interface CreateAmtpAllowRuleInput {
  targetAgentId: string
  peerInstanceId: string
  // Slice 3: 'any' | 'handle'  ('squad' | 'agentKey' deferred)
  principalKind: 'any' | 'handle'
  principalValue?: string | null
}

export class AmtpAllowRule {
  id!: string
  targetAgentId!: string
  peerInstanceId!: string
  principalKind!: 'any' | 'handle'
  principalValue!: string | null
  createdAt!: Date

  constructor(row: AmtpAllowRuleRow) {
    Object.assign(this, row)
    this.principalKind = row.principalKind as 'any' | 'handle'
  }

  toJson() {
    return {
      id: this.id,
      targetAgentId: this.targetAgentId,
      peerInstanceId: this.peerInstanceId,
      principalKind: this.principalKind,
      principalValue: this.principalValue,
      createdAt: this.createdAt,
    }
  }

  static async create(input: CreateAmtpAllowRuleInput): Promise<AmtpAllowRule> {
    if (input.principalKind === 'handle' && !input.principalValue) {
      throw new Error("'handle' allow-rule requires a non-empty principalValue")
    }
    // Normalize: 'any' kind never carries a meaningful principalValue.
    const principalValue = input.principalKind === 'any' ? null : (input.principalValue ?? null)

    // Dedup: return existing rule if one already matches to avoid accumulating noise.
    // Standard SQL UNIQUE can't cover nullable columns uniformly, so we check here.
    const existing = await db
      .select()
      .from(amtpAllowRules)
      .where(
        and(
          eq(amtpAllowRules.targetAgentId, input.targetAgentId),
          eq(amtpAllowRules.peerInstanceId, input.peerInstanceId),
          eq(amtpAllowRules.principalKind, input.principalKind),
          principalValue === null
            ? isNull(amtpAllowRules.principalValue)
            : eq(amtpAllowRules.principalValue, principalValue)
        )
      )
      .limit(1)
    if (existing.length > 0) return new AmtpAllowRule(existing[0])

    const [row] = await db
      .insert(amtpAllowRules)
      .values({
        targetAgentId: input.targetAgentId,
        peerInstanceId: input.peerInstanceId,
        principalKind: input.principalKind,
        principalValue,
      })
      .returning()
    return new AmtpAllowRule(row)
  }

  static async listForAgent(targetAgentId: string): Promise<AmtpAllowRule[]> {
    const rows = await db
      .select()
      .from(amtpAllowRules)
      .where(eq(amtpAllowRules.targetAgentId, targetAgentId))
      .orderBy(amtpAllowRules.createdAt)
    return rows.map((r) => new AmtpAllowRule(r))
  }

  static async delete(id: string): Promise<void> {
    await db.delete(amtpAllowRules).where(eq(amtpAllowRules.id, id))
  }

  /**
   * Delete a rule only if it belongs to the given agent.
   * Returns true when a row was removed, false when none matched
   * (rule not found, or ruleId belongs to a different agent).
   */
  static async deleteForAgent(agentId: string, ruleId: string): Promise<boolean> {
    const deleted = await db
      .delete(amtpAllowRules)
      .where(and(eq(amtpAllowRules.id, ruleId), eq(amtpAllowRules.targetAgentId, agentId)))
      .returning({ id: amtpAllowRules.id })
    return deleted.length > 0
  }
}

/**
 * Default-deny policy gate for remote (cross-instance) senders.
 * Returns true iff at least one rule matches the (targetAgentId, peerInstanceId)
 * pair AND either grants any sender ('any') or the exact sender handle ('handle').
 * With no matching rule, returns false (deny).
 */
export async function isSenderAllowed(args: {
  targetAgentId: string
  peerInstanceId: string
  senderHandle: string
}): Promise<boolean> {
  const rows = await db
    .select({ id: amtpAllowRules.id })
    .from(amtpAllowRules)
    .where(
      and(
        eq(amtpAllowRules.targetAgentId, args.targetAgentId),
        eq(amtpAllowRules.peerInstanceId, args.peerInstanceId),
        or(
          eq(amtpAllowRules.principalKind, 'any'),
          and(eq(amtpAllowRules.principalKind, 'handle'), eq(amtpAllowRules.principalValue, args.senderHandle))
        )
      )
    )
    .limit(1)
  return rows.length > 0
}
