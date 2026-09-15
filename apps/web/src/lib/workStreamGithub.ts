import { resolveCodeHostReference } from '@tau/shared'

interface GithubInfo {
  repo?: string | { owner: string; name: string }
  repoUrl?: string
  prNumber?: number
  prUrl?: string
}

export function getGithubInfo(metadata: Record<string, unknown>): GithubInfo | null {
  const binding = resolveCodeHostReference(metadata)
  const github = (
    metadata.codeHost !== undefined
      ? binding?.integration === 'github'
        ? { repo: binding.repository, pr: binding.changeRequest }
        : undefined
      : metadata.github
  ) as Record<string, any> | undefined
  if (!github?.repo) return null
  const repo =
    typeof github.repo === 'string'
      ? github.repo
      : typeof github.repo === 'object' && github.repo !== null
        ? `${github.repo.owner}/${github.repo.name}`
        : undefined
  const repoUrl = repo ? (repo.startsWith('http') ? repo : `https://github.com/${repo}`) : undefined
  const pr = github.pr as Record<string, unknown> | undefined
  const prNumber = pr?.number ? Number(pr.number) : undefined
  const prUrl =
    pr?.url && typeof pr.url === 'string'
      ? pr.url
      : prNumber
        ? `https://github.com/${repo}/pull/${prNumber}`
        : undefined
  return { repo, repoUrl, prNumber, prUrl }
}
