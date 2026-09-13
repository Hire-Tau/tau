import {
  codeHostReferenceSchema,
  integrationValueAt,
  resolveCodeHostReference,
  type CodeHostReference,
} from '@tau/shared'

/** Shared issue identity for subscriptions and existing-stream matching; never grants access. */
export function resolveGitHubIssueReference(
  metadata: unknown,
  reference: CodeHostReference | null = resolveCodeHostReference(metadata)
) {
  if (reference?.integration !== 'github') return null
  const repository = integrationValueAt(metadata, 'github.repo')
  const rawNumber = integrationValueAt(metadata, 'github.issue')
  if (typeof repository !== 'string' || repository.toLowerCase() !== reference.repository.toLowerCase()) return null
  if (typeof rawNumber !== 'number' && !(typeof rawNumber === 'string' && /^[1-9][0-9]*$/.test(rawNumber))) return null
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number <= 0) return null
  const originMatches =
    integrationValueAt(metadata, 'integrationSource.integration') === 'github' &&
    integrationValueAt(metadata, 'integrationSource.resourceKey') === `${repository.toLowerCase()}#${number}`
  const connectionId =
    integrationValueAt(metadata, 'github.connectionId') ??
    reference.connectionId ??
    (originMatches ? integrationValueAt(metadata, 'integrationSource.connectionId') : undefined)
  const identity = codeHostReferenceSchema.safeParse({ ...reference, connectionId })
  return identity.success
    ? { repository: repository.toLowerCase(), number, connectionId: identity.data.connectionId }
    : null
}
