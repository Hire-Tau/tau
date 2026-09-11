import { eq } from 'drizzle-orm'
import { db, skills } from '../db'
import type { InferSelectModel } from 'drizzle-orm'

export type SkillRow = InferSelectModel<typeof skills>

export type SkillSupportFiles = Record<string, string>

export interface UpsertSkillInput {
  id: string
  name: string
  description?: string | null
  content: string
  supportFiles?: SkillSupportFiles
  requiredPermission?: string | null
}

export class Skill implements SkillRow {
  declare id: string
  declare name: string
  declare description: string | null
  declare content: string
  declare supportFiles: SkillSupportFiles
  declare yamlTemplate: unknown
  declare yamlFieldOverrides: string[]
  declare disabled: boolean
  declare requiredPermission: string | null
  declare createdAt: Date
  declare updatedAt: Date

  private static cache = new Map<string, Skill>()
  private static allCached: Skill[] | null = null
  private static lastCacheRefresh = 0
  private static cacheTimeout = 60_000

  constructor(row: SkillRow) {
    Object.assign(this, row)
  }

  private static isCacheValid(): boolean {
    return Date.now() - this.lastCacheRefresh < this.cacheTimeout
  }

  static invalidateCache(): void {
    this.cache.clear()
    this.allCached = null
    this.lastCacheRefresh = 0
  }

  static async find(id: string): Promise<Skill | null> {
    if (this.isCacheValid() && this.cache.has(id)) return this.cache.get(id)!
    const [row] = await db.select().from(skills).where(eq(skills.id, id))
    if (!row) return null
    const skill = new Skill(row)
    this.cache.set(id, skill)
    return skill
  }

  static async mustFind(id: string): Promise<Skill> {
    const skill = await this.find(id)
    if (!skill) throw new Error(`Skill ${id} not found`)
    return skill
  }

  static async list(options: { includeDisabled?: boolean } = {}): Promise<Skill[]> {
    if (this.isCacheValid() && this.allCached) {
      return options.includeDisabled ? this.allCached : this.allCached.filter((s) => !s.disabled)
    }
    const rows = await db.select().from(skills)
    this.allCached = rows.map((row) => new Skill(row))
    for (const skill of this.allCached) this.cache.set(skill.id, skill)
    this.lastCacheRefresh = Date.now()
    return options.includeDisabled ? this.allCached : this.allCached.filter((s) => !s.disabled)
  }

  static async upsert(input: UpsertSkillInput): Promise<void> {
    await db
      .insert(skills)
      .values({
        id: input.id,
        name: input.name,
        description: input.description ?? null,
        content: input.content,
        supportFiles: input.supportFiles ?? {},
        requiredPermission: input.requiredPermission ?? null,
      })
      .onConflictDoUpdate({
        target: skills.id,
        set: {
          name: input.name,
          description: input.description ?? null,
          content: input.content,
          supportFiles: input.supportFiles ?? {},
          requiredPermission: input.requiredPermission ?? null,
          updatedAt: new Date(),
        },
      })
    this.invalidateCache()
  }

  toJson() {
    return {
      id: this.id,
      name: this.name,
      description: this.description ?? undefined,
      content: this.content,
      supportFiles: this.supportFiles ?? {},
      yamlFieldOverrides: this.yamlFieldOverrides ?? [],
      hasTemplate: this.yamlTemplate != null,
      disabled: this.disabled,
      requiredPermission: this.requiredPermission ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    }
  }
}
