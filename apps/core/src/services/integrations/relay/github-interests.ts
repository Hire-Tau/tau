import {
  effectiveSquadEventRules,
  resolveCodeHostReference,
  integrationValueAt,
  type WorkflowEventTrigger,
} from '@tau/shared'
import { githubRepositoryKey } from '@tau/shared/integration-relay'
import { findGitHubPrUrl, type WorkStreamCandidate } from '../github/watch-policy'

export interface RepositoryInterest {
  squadId: string
  connectionId: string
  repository: string
}
export interface GitHubInterestSource {
  listWorkStreams(): Promise<readonly WorkStreamCandidate[]>
  listSquads(): Promise<readonly { id: string; metadata: unknown }[]>
  resolveConnection(squadId: string, connectionId?: string): Promise<{ id: string } | undefined>
}

/** Exact declared interests only. Webhook presence never suppresses its own subscription. */
export async function discoverGitHubRelayInterests(source: GitHubInterestSource): Promise<RepositoryInterest[]> {
  const [streams, squads] = await Promise.all([source.listWorkStreams(), source.listSquads()])
  const result = new Map<string, RepositoryInterest>()
  const connections = new Map<string, Promise<{ id: string } | undefined>>()
  const add = async (squadId: string, repository: unknown, requested?: string) => {
    const key = githubRepositoryKey.safeParse(repository)
    if (!key.success) return
    const cacheKey = JSON.stringify([squadId, requested])
    if (!connections.has(cacheKey)) connections.set(cacheKey, source.resolveConnection(squadId, requested))
    const connection = await connections.get(cacheKey)
    if (!connection) return
    const interest = { squadId, connectionId: connection.id, repository: key.data }
    result.set(JSON.stringify(interest), interest)
  }
  for (const stream of streams) {
    if (['done', 'canceled'].includes(stream.status)) continue
    const binding = resolveCodeHostReference(stream.metadata)
    const metadata = stream.metadata as {
      codeHost?: unknown
      github?: { repo?: unknown; connectionId?: string }
    } | null
    const github =
      metadata?.codeHost !== undefined
        ? binding?.integration === 'github'
          ? binding
          : null
        : { repository: metadata?.github?.repo, connectionId: metadata?.github?.connectionId }
    await add(stream.squadId, github?.repository, github?.connectionId)
    const pr = findGitHubPrUrl(stream.metadata)
    if (pr) await add(stream.squadId, `${pr.owner}/${pr.repo}`, github?.connectionId)
    for (const subscription of stream.subscriptions ?? []) {
      if (subscription.source.integration !== 'github') continue
      const match = subscription.match.repository
      if (match)
        await add(
          stream.squadId,
          'value' in match ? match.value : integrationValueAt(stream.metadata, match.streamMetadata),
          subscription.source.connectionId
        )
    }
  }
  for (const squad of squads) {
    const metadata = squad.metadata as {
      integrationTriggers?: WorkflowEventTrigger[]
      github?: { repo?: unknown }[]
    } | null
    if (Array.isArray(metadata?.github)) for (const repo of metadata.github) await add(squad.id, repo.repo)
    for (const rule of effectiveSquadEventRules(metadata, 'github')) {
      if (!rule.enabled || rule.action.type === 'ignore') continue
      const repository = rule.filters.repository || rule.match?.repository?.value
      if (repository) await add(squad.id, repository, rule.source.connectionId)
      else if (rule.filters.squadRouting && Array.isArray(metadata?.github))
        for (const repo of metadata.github) await add(squad.id, repo.repo, rule.source.connectionId)
    }
  }
  return [...result.values()]
}
