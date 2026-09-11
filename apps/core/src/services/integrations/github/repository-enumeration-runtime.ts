import { createLogger } from '../../../lib/infra/logger'
import { DbIntegrationAuditRecorder } from '../db-audit'
import { GitHubRepositoryExpander, type RepositoryExpansionWarning } from './repository-enumeration'
import { resolveInstanceGitHubConnection } from './resolve-connection'

const log = createLogger('github-repository-enumeration')
const audit = new DbIntegrationAuditRecorder()
/** Discovery runs every few seconds; say each distinct problem once an hour, not once a cycle. */
const WARNING_REPEAT_MS = 60 * 60_000
const warnedAt = new Map<string, number>()

function reportWarning(warning: RepositoryExpansionWarning) {
  const key = JSON.stringify([warning.connectionId, warning.pattern, warning.code])
  const now = Date.now()
  if ((warnedAt.get(key) ?? 0) > now - WARNING_REPEAT_MS) return
  warnedAt.set(key, now)
  const extra = [
    warning.matched !== undefined ? `matched=${warning.matched} limit=${warning.limit}` : '',
    warning.detail ?? '',
  ]
    .filter(Boolean)
    .join('; ')
  log.warn(
    `Repository pattern ${warning.pattern} on connection ${warning.connectionId} establishes no watches: ${warning.code}${extra ? ` (${extra})` : ''}`
  )
  void audit
    .record({
      connectionId: warning.connectionId,
      action: 'repository_pattern_expansion',
      outcome: 'failed',
      code: warning.code,
      at: new Date(now),
    })
    .catch((error: unknown) => log.warn(`Could not record repository expansion audit: ${String(error)}`))
}

/**
 * The one expander both discovery paths share, so a connection's repository
 * listing is fetched once per refresh whether it serves polling watches or
 * relay interests. Credentials come from the instance-level resolver, which
 * requires a live validated connection; while validation lapses the cached
 * listing keeps serving, matching how relay interests survive that window.
 */
export const githubRepositoryExpander = new GitHubRepositoryExpander({
  resolveCredential: async (connectionId) => {
    const resolved = await resolveInstanceGitHubConnection(connectionId)
    return resolved && { revision: resolved.connection.materialRevision, accessToken: resolved.credential.accessToken }
  },
  onWarning: reportWarning,
})

export const expandGitHubRepositories = (connectionId: string, selectors: readonly string[]) =>
  githubRepositoryExpander.expand(connectionId, selectors)
