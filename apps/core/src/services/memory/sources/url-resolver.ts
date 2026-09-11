import { githubIssueSourceId, parseGithubUrl } from './GitHubIssueSource'
import { parseSlackPermalink, slackThreadSourceId } from './SlackThreadSource'

export interface ResolvedExternalUrl {
  sourceType: 'slack_thread' | 'github_issue'
  sourceId: string
}

export function resolveExternalUrl(url: string): ResolvedExternalUrl | null {
  const slackRef = parseSlackPermalink(url)
  if (slackRef) return { sourceType: 'slack_thread', sourceId: slackThreadSourceId(slackRef) }

  const githubRef = parseGithubUrl(url)
  if (githubRef) return { sourceType: 'github_issue', sourceId: githubIssueSourceId(githubRef) }

  return null
}
