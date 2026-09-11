import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  buildWorkInterestSnapshot,
  type WorkInterestSnapshot,
  type WorkStreamDerivedState,
  type WorkStreamStatus,
  type WorkStreamWait,
} from '@tau/shared'
import { db } from '../../db'
import { users, workStreams } from '../../db/schema'
import { hasPermission } from '../rbac/permissions'
import { listUserWatchedSquadIds } from '../squad/subscriptions'
import { computeDerivedStates } from '../work-streams/derived-state'
import { listUserWatchedWorkStreamIds } from '../work-streams/subscriptions'

export interface WorkInterestCandidate {
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  assigneeAgentId: string | null
  agentIds: string[] | null
  updatedAt: Date
}

interface DerivedFacts {
  derivedState: WorkStreamDerivedState
  openWaits: WorkStreamWait[]
}

export const WORK_INTEREST_AUTH_CONCURRENCY = 8

export interface WorkInterestLoaderDeps {
  isActiveUser(userId: string): Promise<boolean>
  loadWatchedSquadIds(userId: string): Promise<string[]>
  loadWatchedWorkStreamIds(userId: string): Promise<string[]>
  loadCandidates(squadIds: string[], streamIds: string[]): Promise<WorkInterestCandidate[]>
  canReadSquad(userId: string, squadId: string): Promise<boolean>
  derive(streams: WorkInterestCandidate[]): Promise<Map<string, DerivedFacts>>
  now(): Date
}

async function filterAuthorizedSquads(
  squadIds: string[],
  canRead: (squadId: string) => Promise<boolean>
): Promise<Set<string>> {
  const authorized = new Set<string>()
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(WORK_INTEREST_AUTH_CONCURRENCY, squadIds.length) }, async () => {
      while (cursor < squadIds.length) {
        const squadId = squadIds[cursor++]!
        try {
          if (await canRead(squadId)) authorized.add(squadId)
        } catch {
          // Authorization failures are private-data failures: deny this squad rather than exposing it.
        }
      }
    })
  )
  return authorized
}

export function createWorkInterestLoader(deps: WorkInterestLoaderDeps) {
  return async (userId: string): Promise<WorkInterestSnapshot> => {
    if (!(await deps.isActiveUser(userId))) return buildWorkInterestSnapshot([], deps.now())

    const [squadIds, streamIds] = await Promise.all([
      deps.loadWatchedSquadIds(userId),
      deps.loadWatchedWorkStreamIds(userId),
    ])
    if (squadIds.length === 0 && streamIds.length === 0) return buildWorkInterestSnapshot([], deps.now())

    const candidates = await deps.loadCandidates(squadIds, streamIds)
    const deduped = [...new Map(candidates.map((stream) => [stream.id, stream])).values()]
    const candidateSquadIds = [...new Set(deduped.map((stream) => stream.squadId))]
    const authorizedSquads = await filterAuthorizedSquads(candidateSquadIds, (squadId) =>
      deps.canReadSquad(userId, squadId)
    )
    const authorized = deduped.filter((stream) => authorizedSquads.has(stream.squadId))
    const derived = await deps.derive(authorized)
    return buildWorkInterestSnapshot(
      authorized.map((stream) => ({ ...stream, ...derived.get(stream.id) })),
      deps.now()
    )
  }
}

async function loadCandidates(squadIds: string[], streamIds: string[]): Promise<WorkInterestCandidate[]> {
  const interest =
    squadIds.length > 0 && streamIds.length > 0
      ? or(inArray(workStreams.squadId, squadIds), inArray(workStreams.id, streamIds))
      : squadIds.length > 0
        ? inArray(workStreams.squadId, squadIds)
        : inArray(workStreams.id, streamIds)

  return db
    .select({
      id: workStreams.id,
      squadId: workStreams.squadId,
      title: workStreams.title,
      status: workStreams.status,
      assigneeAgentId: workStreams.assigneeAgentId,
      agentIds: workStreams.agentIds,
      updatedAt: workStreams.updatedAt,
    })
    .from(workStreams)
    .where(and(inArray(workStreams.status, ['queued', 'active']), interest))
}

export const loadWorkInterestSnapshot = createWorkInterestLoader({
  isActiveUser: async (userId) => {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .limit(1)
    return Boolean(user)
  },
  loadWatchedSquadIds: listUserWatchedSquadIds,
  loadWatchedWorkStreamIds: listUserWatchedWorkStreamIds,
  loadCandidates,
  canReadSquad: (userId, squadId) => hasPermission({ type: 'user', userId }, 'workstreams:read', squadId),
  derive: computeDerivedStates,
  now: () => new Date(),
})
