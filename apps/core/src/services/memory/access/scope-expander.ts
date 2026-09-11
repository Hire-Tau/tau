import { SquadMemoryGrant } from '../../../entities/SquadMemoryGrant'
import { IndexingService } from '../indexer/IndexingService'
import type { MemorySourceAdapter } from '../sources/adapter'
import type { LiveMemorySourceAdapter } from '../sources/live-adapter'
import { compareSensitivity, parseSensitivity, type SensitivityTier } from './sensitivity'

export interface ScopeRequest {
  sourceTypes?: string[]
  paths?: string[]
  sensitivity?: SensitivityTier
  sourceSquadIds?: string[]
}

export interface AllowedScope {
  squadId: string
  isOwn: boolean
  filters: {
    sourceTypes?: string[]
    paths?: string[]
    sensitivityCeiling?: SensitivityTier
    sourceFilters?: Record<string, unknown>
  }
}

export interface AdapterLookup {
  getAdapter(sourceType: string): MemorySourceAdapter | undefined
  getLiveAdapter?(sourceType: string): LiveMemorySourceAdapter | undefined
}

function validStringArray(value: unknown): value is string[] {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function intersectStringSets(
  grant: string[] | undefined,
  request: string[] | undefined
): { values: string[] | undefined; empty: boolean } {
  if (!grant) return { values: request, empty: false }
  if (!request) return { values: grant, empty: false }
  const requested = new Set(request)
  const values = grant.filter((value) => requested.has(value))
  return { values, empty: values.length === 0 }
}

function pathGlobCovers(grantGlob: string, requestGlob: string): boolean {
  if (grantGlob === requestGlob) return true

  // Conservative phase-B coverage: a grant ending in /** authorizes narrower
  // requests under the same path prefix, but never unrelated prefixes.
  if (grantGlob.endsWith('/**')) {
    const grantPrefix = grantGlob.slice(0, -'/**'.length)
    return requestGlob === grantPrefix || requestGlob.startsWith(`${grantPrefix}/`)
  }

  return false
}

function intersectPaths(
  grant: string[] | undefined,
  request: string[] | undefined
): { values: string[] | undefined; empty: boolean } {
  if (!grant) return { values: request, empty: false }
  if (!request) return { values: grant, empty: false }

  const coveredRequests = request.filter((requestPath) =>
    grant.some((grantPath) => pathGlobCovers(grantPath, requestPath))
  )
  return { values: coveredRequests, empty: coveredRequests.length === 0 }
}

function tighterSensitivity(
  grant: SensitivityTier | undefined,
  request: SensitivityTier | undefined
): SensitivityTier | undefined {
  if (!grant) return request
  if (!request) return grant
  return compareSensitivity(grant, request) <= 0 ? grant : request
}

function validateSourceFilters(
  sourceFilters: Record<string, unknown> | undefined,
  adapters: AdapterLookup
): Record<string, unknown> | null | undefined {
  if (sourceFilters === undefined) return undefined
  if (!sourceFilters || typeof sourceFilters !== 'object' || Array.isArray(sourceFilters)) return null

  const validated: Record<string, unknown> = {}
  for (const [sourceType, filter] of Object.entries(sourceFilters)) {
    const adapter = adapters.getAdapter(sourceType) ?? adapters.getLiveAdapter?.(sourceType)
    if (!adapter) return null
    const errors = adapter.validateGrantFilter?.(filter)
    if (errors?.length) return null
    validated[sourceType] = filter
  }
  return validated
}

export async function expandReadScope(
  callerSquadId: string,
  request: ScopeRequest,
  adapters: AdapterLookup = IndexingService.instance()
): Promise<AllowedScope[]> {
  const scopes: AllowedScope[] = []

  if (!request.sourceSquadIds || request.sourceSquadIds.includes(callerSquadId)) {
    scopes.push({
      squadId: callerSquadId,
      isOwn: true,
      filters: {
        sourceTypes: request.sourceTypes,
        paths: request.paths,
        sensitivityCeiling: request.sensitivity,
      },
    })
  }

  const grants = await SquadMemoryGrant.findActiveByGrantee(callerSquadId)
  for (const grant of grants) {
    if (request.sourceSquadIds && !request.sourceSquadIds.includes(grant.sourceSquadId)) continue

    const read = grant.policy.read
    if (!read) continue
    if (!validStringArray(read.sourceTypes) || !validStringArray(read.paths)) continue
    if (read.sensitivity && parseSensitivity(read.sensitivity) !== read.sensitivity) continue

    const sourceFilters = validateSourceFilters(read.sourceFilters, adapters)
    if (sourceFilters === null) continue

    const sourceTypes = intersectStringSets(read.sourceTypes, request.sourceTypes)
    if (sourceTypes.empty) continue

    const paths = intersectPaths(read.paths, request.paths)
    if (paths.empty) continue

    const filters: AllowedScope['filters'] = {
      sourceTypes: sourceTypes.values,
      paths: paths.values,
      sensitivityCeiling: tighterSensitivity(read.sensitivity, request.sensitivity),
    }
    if (sourceFilters) filters.sourceFilters = sourceFilters

    scopes.push({
      squadId: grant.sourceSquadId,
      isOwn: false,
      filters,
    })
  }

  return scopes
}
