import { lstat, readdir, rmdir } from 'fs/promises'
import { join } from 'path'
import { db } from '../../db'
import { squads } from '../../db/schema'
import { getSandboxManager } from '../sandbox/factory'
import { getSquadsBasePath, isCanonicalSquadId } from './workspace'

const DEFAULT_LIMIT = 1_000
export const MAX_WORKSPACE_GC_LIMIT = 5_000
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/

export interface WorkspaceGcRequest {
  apply?: boolean
  limit?: number
  cursor?: string
}

export interface WorkspaceGcResult {
  mode: 'dry-run' | 'apply'
  scanned: number
  eligible: number
  removed: number
  protected: Record<string, number>
  skipped: Record<string, number>
  errors: Record<string, number>
  hasMore: boolean
  nextCursor: string | null
}

interface WorkspaceGcDependencies {
  getRoot?: () => string
  listSquadIds?: () => Promise<Set<string>>
  getSandboxStatus?: (sandboxId: string) => Promise<string>
  beforeRemove?: (path: string) => Promise<unknown>
  fs?: {
    lstat: typeof lstat
    readdir: typeof readdir
    rmdir: typeof rmdir
  }
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1
}

function encodeCursor(name: string): string {
  return Buffer.from(name).toString('base64url')
}

export function decodeWorkspaceGcCursor(cursor: string): string {
  if (!cursor || cursor.length > 255 || !CURSOR_PATTERN.test(cursor)) throw new Error('Invalid workspace GC cursor')
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!decoded || encodeCursor(decoded) !== cursor || decoded.includes('/') || decoded.includes('\\')) {
    throw new Error('Invalid workspace GC cursor')
  }
  return decoded
}

async function defaultListSquadIds(): Promise<Set<string>> {
  const rows = await db.select({ id: squads.id }).from(squads)
  return new Set(rows.map((row) => row.id))
}

async function defaultGetSandboxStatus(sandboxId: string): Promise<string> {
  const manager = getSandboxManager()
  if (!manager.getSandboxStatus) return 'unknown'
  return (await manager.getSandboxStatus(sandboxId)).status
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
}

/**
 * Reconcile immediate empty orphan directories below the canonical squad root.
 * Dry-run is the default. Apply mode mutates only through non-recursive rmdir.
 */
export async function reconcileWorkspaceStubs(
  request: WorkspaceGcRequest = {},
  dependencies: WorkspaceGcDependencies = {}
): Promise<WorkspaceGcResult> {
  const limit = request.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_GC_LIMIT)
    throw new Error('Invalid workspace GC limit')
  const afterName = request.cursor ? decodeWorkspaceGcCursor(request.cursor) : null
  const result: WorkspaceGcResult = {
    mode: request.apply ? 'apply' : 'dry-run',
    scanned: 0,
    eligible: 0,
    removed: 0,
    protected: {},
    skipped: {},
    errors: {},
    hasMore: false,
    nextCursor: null,
  }
  const root = (dependencies.getRoot ?? getSquadsBasePath)()
  const listSquadIds = dependencies.listSquadIds ?? defaultListSquadIds
  const getSandboxStatus = dependencies.getSandboxStatus ?? defaultGetSandboxStatus
  const fs = dependencies.fs ?? { lstat, readdir, rmdir }

  // The DB snapshot is authoritative. If it cannot be loaded, fail before any mutation.
  let extantSquadIds = await listSquadIds()
  let rootStat
  try {
    rootStat = await fs.lstat(root)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return result
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error('Squad workspace root is not a real directory')

  const allNames = (await fs.readdir(root)).sort()
  const remaining = afterName === null ? allNames : allNames.filter((name) => name > afterName)
  const page = remaining.slice(0, limit)
  result.hasMore = remaining.length > page.length
  result.scanned = page.length
  result.nextCursor = result.hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null

  for (const name of page) {
    if (!isCanonicalSquadId(name)) {
      increment(result.skipped, 'invalid_name')
      continue
    }
    if (extantSquadIds.has(name)) {
      increment(result.protected, 'extant_squad')
      continue
    }

    const candidatePath = join(root, name)
    let candidateStat
    try {
      candidateStat = await fs.lstat(candidatePath)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') increment(result.skipped, 'absent')
      else increment(result.errors, code)
      continue
    }
    if (candidateStat.isSymbolicLink()) {
      increment(result.protected, 'symlink')
      continue
    }
    if (!candidateStat.isDirectory()) {
      increment(result.protected, 'special_file')
      continue
    }

    let entries: string[]
    try {
      entries = await fs.readdir(candidatePath)
    } catch (error) {
      increment(result.errors, errorCode(error))
      continue
    }
    if (entries.length > 0) {
      increment(result.protected, 'non_empty')
      continue
    }

    let status: string
    try {
      status = await getSandboxStatus(`squad_${name}`)
    } catch {
      increment(result.protected, 'sandbox_status_error')
      continue
    }
    if (status !== 'not_found') {
      increment(result.protected, 'sandbox_present')
      continue
    }

    result.eligible++
    if (!request.apply) continue

    // Revalidate ownership and runtime state immediately before the only mutation.
    extantSquadIds = await listSquadIds()
    if (extantSquadIds.has(name)) {
      increment(result.protected, 'extant_squad')
      continue
    }
    try {
      await dependencies.beforeRemove?.(candidatePath)
      const freshStat = await fs.lstat(candidatePath)
      if (freshStat.isSymbolicLink() || !freshStat.isDirectory() || (await fs.readdir(candidatePath)).length > 0) {
        increment(result.protected, 'changed')
        continue
      }
      if ((await getSandboxStatus(`squad_${name}`)) !== 'not_found') {
        increment(result.protected, 'sandbox_present')
        continue
      }
      await fs.rmdir(candidatePath)
      result.removed++
    } catch (error) {
      const code = errorCode(error)
      if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(code)) increment(result.protected, 'changed')
      else increment(result.errors, code)
    }
  }

  return result
}
