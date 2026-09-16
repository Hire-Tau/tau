import { createHash } from 'node:crypto'
import { trackedResourceKey, trackedResourceLabel, type IntegrationSubscription } from '@tau/shared'
import { resolveLinearAssignment, resolveLinearConnection } from '../linear/resolve-connection'
import { linearQuery } from '../linear/plugin'
import type { TrackedResourceAdapter } from './registry'

const ISSUE_EVENTS = ['assigned', 'unassigned', 'updated', 'comment']
/** A Linear team key is a short alphanumeric code such as `ENG`, never an `owner/repo` path. */
const TEAM_KEY = /^[a-z][a-z0-9]{0,9}$/i
const ISSUE_QUERY = 'query Issue($id: String!) { issue(id: $id) { id url number team { key } } }'

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

export const linearTrackedResourceAdapter: TrackedResourceAdapter = {
  integration: 'linear',
  validateRepository: (repository) => TEAM_KEY.test(repository.trim()),
  matchFields: () => ({ repository: 'teamKey', number: 'issue.number', externalId: 'issue.id' }),
  /** Ids hash the resource identity, so adding or removing a link never renumbers the others. */
  trackedSubscriptions(resource) {
    // Linear tracks issues only; a pull request lives on the code host, not here.
    if (resource.kind !== 'issue') return []
    const hash = createHash('sha256').update(trackedResourceKey(resource)).digest('hex').slice(0, 12)
    return ISSUE_EVENTS.map(
      (event): IntegrationSubscription => ({
        id: `tracked-${hash}-${event}`,
        source: {
          integration: 'linear',
          output: `issue.${event}`,
          version: 1,
          ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
        },
        // The provider id identifies the issue on its own; a comment fact carries nothing else.
        match: resource.externalId
          ? { 'issue.id': { value: resource.externalId } }
          : {
              teamKey: { value: resource.repository.trim().toLowerCase() },
              'issue.number': { value: resource.number },
            },
        deliver: { to: 'delivery-owner', whenInactive: 'retain' },
      })
    )
  },
  async authorizeSquad(squadId, connectionId) {
    const assignment = await resolveLinearAssignment(squadId)
    return !!assignment && (!connectionId || assignment.id === connectionId)
  },
  /** Reads the squad's own connection. A resource it cannot see is reported as unknown, not as an error. */
  async describe(resource, squadId) {
    const resolved = await resolveLinearConnection(squadId)
    if (!resolved) return null
    let issue: Record<string, unknown> | null | undefined
    try {
      // Provider failures are identity answers here, not diagnostics: never leak provider text.
      ;({ issue } = await linearQuery<{ issue?: Record<string, unknown> | null }>(resolved.credential, ISSUE_QUERY, {
        id: trackedResourceLabel(resource),
      }))
    } catch {
      return null
    }
    const externalId = text(issue?.id, 200)
    if (!externalId) return null
    const team = issue?.team && typeof issue.team === 'object' ? (issue.team as Record<string, unknown>) : undefined
    const key = text(team?.key, 100)
    const number = typeof issue?.number === 'number' && Number.isSafeInteger(issue.number) ? issue.number : undefined
    return {
      externalId,
      ...(text(issue?.url, 2000) ? { url: text(issue?.url, 2000)! } : {}),
      ...(key ? { repository: key.toLowerCase() } : {}),
      ...(number && number > 0 ? { number } : {}),
    }
  },
}
