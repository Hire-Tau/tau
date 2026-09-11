import { SquadMemoryGrant } from '../../../entities/SquadMemoryGrant'

export type WriteDenialReason = 'no_grant' | 'no_write_policy' | 'source_type_not_covered' | 'path_not_covered'

export interface WriteScopeRequest {
  path: string
  sourceType: string
}

export interface WriteScopeResult {
  allowed: boolean
  reason?: WriteDenialReason
  grantId?: string
}

function pathGlobCovers(grantGlob: string, requestPath: string): boolean {
  if (grantGlob === requestPath) return true
  if (grantGlob.endsWith('/**')) {
    const prefix = grantGlob.slice(0, -'/**'.length)
    return requestPath === prefix || requestPath.startsWith(`${prefix}/`)
  }
  return false
}

export async function canWriteToSquad(
  callerSquadId: string,
  targetSquadId: string,
  request: WriteScopeRequest
): Promise<WriteScopeResult> {
  if (callerSquadId === targetSquadId) return { allowed: true }

  const grants = await SquadMemoryGrant.findActiveByGrantee(callerSquadId)
  const matching = grants.filter((grant) => grant.sourceSquadId === targetSquadId)
  if (matching.length === 0) return { allowed: false, reason: 'no_grant' }

  let sawWritePolicy = false
  let sawSourceTypeMatch = false
  for (const grant of matching) {
    const write = grant.policy.write
    if (!write) continue
    sawWritePolicy = true

    if (write.sourceTypes && !write.sourceTypes.includes(request.sourceType)) continue
    sawSourceTypeMatch = true

    if (write.paths && !write.paths.some((path) => pathGlobCovers(path, request.path))) continue

    return { allowed: true, grantId: grant.id }
  }

  if (!sawWritePolicy) return { allowed: false, reason: 'no_write_policy' }
  if (!sawSourceTypeMatch) return { allowed: false, reason: 'source_type_not_covered' }
  return { allowed: false, reason: 'path_not_covered' }
}
