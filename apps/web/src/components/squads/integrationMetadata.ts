export interface GithubIdentityForm {
  gitUserName: string
  gitUserEmail: string
}

export function githubIdentityFromMetadata(metadata: unknown): GithubIdentityForm {
  const identity = (metadata as { githubIdentity?: unknown } | null | undefined)?.githubIdentity
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    return { gitUserName: '', gitUserEmail: '' }
  }
  const record = identity as Record<string, unknown>
  return {
    gitUserName: typeof record.gitUserName === 'string' ? record.gitUserName : '',
    gitUserEmail: typeof record.gitUserEmail === 'string' ? record.gitUserEmail : '',
  }
}

export function githubIdentityToMetadata(
  currentMetadata: Record<string, unknown> | null | undefined,
  form: GithubIdentityForm
): Record<string, unknown> {
  const githubIdentity = Object.fromEntries(
    Object.entries({
      gitUserName: form.gitUserName.trim(),
      gitUserEmail: form.gitUserEmail.trim(),
    }).filter(([, value]) => value.length > 0)
  )
  const metadata = { ...(currentMetadata ?? {}) }
  if (Object.keys(githubIdentity).length > 0) metadata.githubIdentity = githubIdentity
  else delete metadata.githubIdentity
  return metadata
}

export interface GithubRoutingFormEntry {
  repo: string
  labelsText: string
}

interface GithubRoutingMetadataEntry {
  repo?: unknown
  labels?: unknown
}

function splitLabels(labelsText: string): string[] {
  return labelsText
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
}

export function githubRoutingFromMetadata(metadata: unknown): GithubRoutingFormEntry[] {
  const github = (metadata as { github?: unknown } | null | undefined)?.github
  if (!Array.isArray(github)) return []

  return github
    .filter((entry): entry is GithubRoutingMetadataEntry => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      repo: typeof entry.repo === 'string' ? entry.repo : '',
      labelsText: Array.isArray(entry.labels)
        ? entry.labels.filter((label) => typeof label === 'string').join(', ')
        : '',
    }))
    .filter((entry) => entry.repo.trim().length > 0)
}

export function githubRoutingToMetadata(
  currentMetadata: Record<string, unknown> | null | undefined,
  entries: GithubRoutingFormEntry[]
): Record<string, unknown> {
  const github = entries
    .map((entry) => ({ repo: entry.repo.trim(), labels: splitLabels(entry.labelsText) }))
    .filter((entry) => entry.repo.length > 0)
    .map((entry) => (entry.labels.length > 0 ? entry : { repo: entry.repo }))

  return {
    ...(currentMetadata ?? {}),
    github,
  }
}

export interface LinearRoutingFormEntry {
  teamId: string
}

export function linearRoutingFromMetadata(metadata: unknown): LinearRoutingFormEntry[] {
  const linear = (metadata as { linear?: unknown } | null | undefined)?.linear
  if (!Array.isArray(linear)) return []

  return linear
    .filter((entry): entry is { teamId?: unknown } => typeof entry === 'object' && entry !== null)
    .map((entry) => ({ teamId: typeof entry.teamId === 'string' ? entry.teamId : '' }))
    .filter((entry) => entry.teamId.trim().length > 0)
}

export function linearRoutingToMetadata(
  currentMetadata: Record<string, unknown> | null | undefined,
  entries: LinearRoutingFormEntry[]
): Record<string, unknown> {
  return {
    ...(currentMetadata ?? {}),
    linear: entries.map((entry) => ({ teamId: entry.teamId.trim() })).filter((entry) => entry.teamId.length > 0),
  }
}
