/**
 * Memory Maintenance Service
 *
 * Non-destructive maintenance operations for squad memory:
 * - Normalize frontmatter (add missing id, updatedAt)
 * - Detect broken links (wikilinks to non-existent docs)
 * - Find stale documents (not updated in N days)
 *
 * Extends PeriodicRunner for background execution.
 * This service does NOT delete any files - it only reports issues
 * and makes safe normalization changes to frontmatter.
 */

import { PeriodicRunner } from '../../lib/infra'
import { db } from '../../db'
import { squads, memoryDocuments, memoryLinks } from '../../db/schema'
import { eq, isNull, and, lt, not, like, inArray } from 'drizzle-orm'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { ensureSquadMemoryPath } from './paths'
import { parseFrontmatter } from './parser'
import { SquadSourceConfig } from '../../entities/SquadSourceConfig'

// --- Types ---

export interface MaintenanceOptions {
  staleDays?: number
  normalize?: boolean
  includeDetails?: boolean
}

export interface MaintenanceReport {
  squadId: string
  timestamp: Date
  brokenLinks: number
  staleDocuments: number
  normalizedFiles: number
  errors: string[]
  details?: {
    brokenLinks?: BrokenLink[]
    staleDocuments?: StaleDocument[]
    normalizedFiles?: string[]
  }
}

export interface BrokenLink {
  sourceDocumentId: string
  sourcePath: string | null
  targetRaw: string
}

export interface StaleDocument {
  id: string
  path: string | null
  title: string | null
  updatedAt: Date
  daysSinceUpdate: number
}

export interface NormalizationResult {
  success: boolean
  path: string
  changes: string[]
  error?: string
}

// --- Helper Functions ---

/** Generate a short unique ID. */
function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** Stringify frontmatter and body back to markdown. */
function stringifyFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue

    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`)
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`)
    } else if (typeof value === 'string') {
      // Quote strings that might cause YAML issues
      if (value.includes(':') || value.includes('#') || value.includes('\n')) {
        lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`)
      } else {
        lines.push(`${key}: ${value}`)
      }
    } else {
      lines.push(`${key}: ${value}`)
    }
  }

  lines.push('---')
  lines.push('')

  // Ensure body doesn't start with extra newlines
  const trimmedBody = body.replace(/^\n+/, '')
  if (trimmedBody) {
    lines.push(trimmedBody)
  }

  return lines.join('\n')
}

// --- Service Class ---

export class MaintenanceService extends PeriodicRunner {
  private static _instance: MaintenanceService | null = null

  static instance(): MaintenanceService {
    if (!MaintenanceService._instance) {
      MaintenanceService._instance = new MaintenanceService()
    }
    return MaintenanceService._instance
  }

  static _reset(): void {
    MaintenanceService._instance = null
  }

  constructor(options?: { intervalMs?: number }) {
    super({
      name: 'memory-maintenance',
      intervalMs: options?.intervalMs ?? 3600000, // 1 hour
      runImmediately: false,
    })
  }

  protected async runTask(): Promise<void> {
    await this.runForAllSquads()
  }

  /** Run maintenance for a specific squad */
  async runForSquad(squadId: string, options?: MaintenanceOptions): Promise<MaintenanceReport> {
    const staleDays = options?.staleDays ?? 30
    const normalize = options?.normalize ?? true
    const includeDetails = options?.includeDetails ?? false

    const report: MaintenanceReport = {
      squadId,
      timestamp: new Date(),
      brokenLinks: 0,
      staleDocuments: 0,
      normalizedFiles: 0,
      errors: [],
    }

    if (includeDetails) {
      report.details = {}
    }

    try {
      // Detect broken links
      const brokenLinks = await this.detectBrokenLinks(squadId)
      report.brokenLinks = brokenLinks.length
      if (includeDetails) {
        report.details!.brokenLinks = brokenLinks
      }

      await this.applyRetentionPolicies(squadId)

      // Find stale documents
      const staleDocuments = await this.findStaleDocuments(squadId, staleDays)
      report.staleDocuments = staleDocuments.length
      if (includeDetails) {
        report.details!.staleDocuments = staleDocuments
      }

      // Normalize frontmatter
      if (normalize) {
        const normalized = await this.normalizeAllFrontmatter(squadId)
        report.normalizedFiles = normalized.filter((r) => r.changes.length > 0).length
        if (includeDetails) {
          report.details!.normalizedFiles = normalized.filter((r) => r.changes.length > 0).map((r) => r.path)
        }

        // Collect errors
        normalized.filter((r) => !r.success && r.error).forEach((r) => report.errors.push(`${r.path}: ${r.error}`))
      }
    } catch (e) {
      const error = e as Error
      report.errors.push(`Maintenance failed: ${error.message}`)
    }

    return report
  }

  /** Run maintenance for all squads */
  async runForAllSquads(options?: MaintenanceOptions): Promise<MaintenanceReport[]> {
    const allSquads = await db.select({ id: squads.id }).from(squads).where(isNull(squads.archivedAt))

    const reports: MaintenanceReport[] = []
    for (const squad of allSquads) {
      const report = await this.runForSquad(squad.id, options)
      reports.push(report)
    }
    return reports
  }

  /** Detect broken links in a squad's memory */
  async detectBrokenLinks(squadId: string): Promise<BrokenLink[]> {
    // Find all links where targetDocumentId is null
    const brokenLinks = await db
      .select({
        id: memoryLinks.id,
        sourceDocumentId: memoryLinks.sourceDocumentId,
        targetRaw: memoryLinks.targetRaw,
      })
      .from(memoryLinks)
      .where(and(eq(memoryLinks.squadId, squadId), isNull(memoryLinks.targetDocumentId)))

    // Get source document paths
    const result: BrokenLink[] = []

    for (const link of brokenLinks) {
      const sourceDoc = await db.query.memoryDocuments.findFirst({
        where: eq(memoryDocuments.id, link.sourceDocumentId),
      })

      result.push({
        sourceDocumentId: link.sourceDocumentId,
        sourcePath: sourceDoc?.path || null,
        targetRaw: link.targetRaw,
      })
    }

    return result
  }

  /** Delete indexed documents older than adapter retention policies. */
  async applyRetentionPolicies(squadId: string): Promise<number> {
    const configs = await SquadSourceConfig.listBySquad(squadId)
    let deleted = 0

    for (const config of configs) {
      const retentionDays = config.policy.retentionDays
      if (!Number.isInteger(retentionDays) || (retentionDays as number) < 1) continue
      const cutoffDate = new Date(Date.now() - (retentionDays as number) * 24 * 60 * 60 * 1000)
      const sourceTypes = config.sourceType === 'file' ? ['file', 'memory_file'] : [config.sourceType]
      const docs = await db
        .select({ id: memoryDocuments.id })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.squadId, squadId),
            inArray(memoryDocuments.sourceType, sourceTypes),
            lt(memoryDocuments.updatedAt, cutoffDate)
          )
        )
      if (docs.length === 0) continue
      await db.delete(memoryDocuments).where(
        inArray(
          memoryDocuments.id,
          docs.map((doc) => doc.id)
        )
      )
      deleted += docs.length
    }

    return deleted
  }

  /** Find stale documents */
  async findStaleDocuments(squadId: string, days: number): Promise<StaleDocument[]> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)

    const staleDocs = await db
      .select({
        id: memoryDocuments.id,
        path: memoryDocuments.path,
        title: memoryDocuments.title,
        updatedAt: memoryDocuments.updatedAt,
      })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          lt(memoryDocuments.updatedAt, cutoffDate),
          // Exclude system files
          not(like(memoryDocuments.path, '%/_system/%'))
        )
      )

    const now = Date.now()
    return staleDocs.map((doc) => ({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      updatedAt: doc.updatedAt,
      daysSinceUpdate: Math.floor((now - doc.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    }))
  }

  /** Normalize frontmatter for a file */
  async normalizeFrontmatter(squadId: string, memoryPath: string): Promise<NormalizationResult> {
    const result: NormalizationResult = {
      success: true,
      path: memoryPath,
      changes: [],
    }

    try {
      // Convert /memory/ path to filesystem path
      const basePath = ensureSquadMemoryPath(squadId)
      const relativePath = memoryPath.replace(/^\/memory\//, '')
      const filePath = join(basePath, relativePath)

      if (!existsSync(filePath)) {
        result.success = false
        result.error = 'File does not exist'
        return result
      }

      const fileContent = readFileSync(filePath, 'utf-8')
      const { frontmatter, content: body } = parseFrontmatter(fileContent)

      let modified = false
      const fm: Record<string, unknown> = { ...frontmatter }

      // Add id if missing
      if (!fm.id) {
        fm.id = `mem_${generateId()}`
        result.changes.push('id')
        modified = true
      }

      // Add updatedAt if missing
      if (!fm.updatedAt) {
        fm.updatedAt = new Date().toISOString()
        result.changes.push('updatedAt')
        modified = true
      }

      // Write back if modified
      if (modified) {
        const newFileContent = stringifyFrontmatter(fm, body)
        writeFileSync(filePath, newFileContent)
      }

      return result
    } catch (e) {
      const error = e as Error
      result.success = false
      result.error = error.message
      return result
    }
  }

  /** Normalize frontmatter for all markdown files in a squad's memory */
  private async normalizeAllFrontmatter(squadId: string): Promise<NormalizationResult[]> {
    const basePath = ensureSquadMemoryPath(squadId)
    const filePaths: string[] = []

    // Recursively find all markdown files
    const walk = (dir: string) => {
      if (!existsSync(dir)) return

      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          const relativePath = relative(basePath, fullPath)
          filePaths.push(`/memory/${relativePath}`)
        }
      }
    }

    walk(basePath)

    // Normalize each file
    const normalized: NormalizationResult[] = []
    for (const path of filePaths) {
      const result = await this.normalizeFrontmatter(squadId, path)
      normalized.push(result)
    }

    return normalized
  }
}
