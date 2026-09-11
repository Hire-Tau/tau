import { resolveCodeHostReference } from '@tau/shared'
export interface CanonicalGitHubPrMetadata {
  repository: string
  number: number
  url: string
}

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Strict shared decoder for polling discovery and Activity attribution. Legacy recursive PR URLs are intentionally ignored. */
export function decodeGitHubPrWorkStreamMetadata(value: unknown): CanonicalGitHubPrMetadata | null {
  const metadata = object(value)
  const binding = resolveCodeHostReference(value)
  const github =
    metadata?.codeHost !== undefined
      ? binding?.integration === 'github'
        ? { repo: binding.repository, pr: binding.changeRequest }
        : null
      : object(metadata?.github)
  const pr = object(github?.pr)
  const repository = typeof github?.repo === 'string' ? github.repo.trim().toLowerCase() : ''
  const rawNumber = pr?.number
  const number = typeof rawNumber === 'number' ? rawNumber : NaN
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(number) || number <= 0) return null
  const canonicalUrl = `https://github.com/${repository}/pull/${number}`
  const url = typeof pr?.url === 'string' && pr.url.trim() === canonicalUrl ? pr.url.trim() : canonicalUrl
  return { repository, number, url }
}
