import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { agents, monitors } from '../db/schema'
import { BaseEntity } from './base'

export type MonitorRow = typeof monitors.$inferSelect
export type NewMonitor = typeof monitors.$inferInsert
export type MonitorStatus = MonitorRow['status']
export type UpdateMonitorInput = Partial<Omit<MonitorRow, 'id' | 'createdAt'>>

const ACTIVE_STATUSES: MonitorStatus[] = ['starting', 'running', 'canceling']

export class Monitor extends BaseEntity<any, UpdateMonitorInput> implements MonitorRow {
  declare id: string
  declare agentId: string
  declare sandboxId: string
  declare label: string
  declare description: string | null
  declare command: string
  declare cwd: string | null
  declare status: MonitorStatus
  declare processId: string
  declare timeoutMs: number
  declare maxBatchLines: number
  declare maxBatchBytes: number
  declare batchDebounceMs: number
  declare exitCode: number | null
  declare lastBatchAt: Date | null
  declare linesEmitted: number
  declare bytesEmitted: number
  declare createdAt: Date
  declare startedAt: Date | null
  declare endedAt: Date | null
  declare failureReason: string | null
  declare failureKind: string | null

  constructor(row: MonitorRow) {
    super()
    Object.assign(this, row)
    const safe = {
      label: row.label,
      description: row.description,
      command: row.command,
      failureReason: row.failureReason,
    }
    Object.assign(this, safe)
  }

  static activeStatuses(): MonitorStatus[] {
    return [...ACTIVE_STATUSES]
  }

  static async create(input: NewMonitor): Promise<Monitor> {
    const safe = {
      label: input.label,
      description: input.description,
      command: input.command,
    }
    const [row] = await db
      .insert(monitors)
      .values({ ...input, ...safe })
      .returning()
    return new Monitor(row)
  }

  static async find(id: string): Promise<Monitor | null> {
    const [row] = await db.select().from(monitors).where(eq(monitors.id, id))
    return row ? new Monitor(row) : null
  }

  static async mustFind(id: string): Promise<Monitor> {
    const monitor = await Monitor.find(id)
    if (!monitor) throw new Error(`Monitor ${id} not found`)
    return monitor
  }

  static async listForAgent(agentId: string, opts?: { status?: MonitorStatus[] }): Promise<Monitor[]> {
    const conditions = [eq(monitors.agentId, agentId)]
    if (opts?.status?.length) conditions.push(inArray(monitors.status, opts.status))
    const rows = await db
      .select()
      .from(monitors)
      .where(and(...conditions))
      .orderBy(desc(monitors.createdAt))
    return rows.map((row) => new Monitor(row))
  }

  static async listActive(): Promise<Monitor[]> {
    const rows = await db.select().from(monitors).where(inArray(monitors.status, ACTIVE_STATUSES))
    return rows.map((row) => new Monitor(row))
  }

  static async listForSquad(squadId: string, opts?: { status?: MonitorStatus[] }): Promise<Monitor[]> {
    const conditions = [eq(agents.squadId, squadId)]
    if (opts?.status?.length) conditions.push(inArray(monitors.status, opts.status))
    const rows = await db
      .select({ monitor: monitors })
      .from(monitors)
      .innerJoin(agents, eq(agents.id, monitors.agentId))
      .where(and(...conditions))
      .orderBy(desc(monitors.createdAt))
    return rows.map((row) => new Monitor(row.monitor))
  }

  static async listRecent(limit: number, opts?: { status?: MonitorStatus[] }): Promise<Monitor[]> {
    const query = db
      .select()
      .from(monitors)
      .where(opts?.status?.length ? inArray(monitors.status, opts.status) : undefined)
      .orderBy(desc(monitors.createdAt))
      .limit(limit)
    const rows = await query
    return rows.map((row) => new Monitor(row))
  }

  async update(patch: UpdateMonitorInput): Promise<this> {
    const safe = {
      label: patch.label,
      description: patch.description,
      command: patch.command,
      failureReason: patch.failureReason,
    }
    const [row] = await db
      .update(monitors)
      .set({ ...patch, ...safe })
      .where(eq(monitors.id, this.id))
      .returning()
    if (!row) throw new Error(`Monitor ${this.id} not found`)
    Object.assign(this, row)
    return this
  }

  async reload(): Promise<this> {
    const fresh = await Monitor.mustFind(this.id)
    Object.assign(this, fresh)
    return this
  }

  async markRunning(): Promise<void> {
    await this.update({ status: 'running', startedAt: new Date() })
  }

  async markEnded(
    status: 'exited' | 'canceled' | 'timed-out' | 'failed' | 'overload',
    exitCode: number | null,
    reason?: string,
    failureKind?: string | null
  ): Promise<void> {
    await this.update({
      status,
      exitCode,
      endedAt: new Date(),
      failureReason: reason ?? null,
      failureKind: failureKind ?? null,
    })
  }

  toJson(): any {
    return {
      id: this.id,
      agentId: this.agentId,
      sandboxId: this.sandboxId,
      label: this.label,
      description: this.description,
      command: this.command,
      cwd: this.cwd,
      status: this.status,
      processId: this.processId,
      timeoutMs: this.timeoutMs,
      maxBatchLines: this.maxBatchLines,
      maxBatchBytes: this.maxBatchBytes,
      batchDebounceMs: this.batchDebounceMs,
      exitCode: this.exitCode,
      failureReason: this.failureReason,
      failureKind: this.failureKind,
      linesEmitted: this.linesEmitted,
      bytesEmitted: this.bytesEmitted,
      createdAt: this.createdAt.toISOString(),
      startedAt: this.startedAt?.toISOString() ?? null,
      endedAt: this.endedAt?.toISOString() ?? null,
      lastBatchAt: this.lastBatchAt?.toISOString() ?? null,
    }
  }
}
