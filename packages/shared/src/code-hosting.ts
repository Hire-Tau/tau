import { z } from 'zod'

/** Resource identity only. Access always comes from the integration's squad connection. */
export const codeHostReferenceSchema = z
  .object({
    integration: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(100),
    repository: z.string().trim().min(1).max(500),
    changeRequest: z
      .object({ number: z.number().int().positive().safe(), url: z.string().url().optional() })
      .strict()
      .optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict()
export type CodeHostReference = z.infer<typeof codeHostReferenceSchema>

export type CodeHostReferenceDescription =
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'valid'; reference: CodeHostReference }

/** Human-readable, path-qualified Zod issues; unknown keys also list the accepted keys. */
export function formatCodeHostIssues(error: z.ZodError): string[] {
  const allowed: Record<string, string[]> = {
    '': Object.keys(codeHostReferenceSchema.shape),
    changeRequest: Object.keys(codeHostReferenceSchema.shape.changeRequest.unwrap().shape),
  }
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    const where = path ? `codeHost.${path}` : 'codeHost'
    if (issue.code === 'unrecognized_keys') {
      const accepted = allowed[path] ?? []
      return `${where}: unknown keys ${issue.keys.map((key) => `\`${key}\``).join(', ')} (allowed: ${accepted.join(', ')})`
    }
    return `${where}: ${issue.message}`
  })
}

/**
 * An explicit canonical `codeHost` binding takes precedence over the legacy `github` shape,
 * including when it is invalid: an invalid binding is reported as such rather than falling back.
 */
export function describeCodeHostReference(metadata: unknown): CodeHostReferenceDescription {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'absent' }
  const record = metadata as Record<string, any>
  const value =
    record.codeHost !== undefined
      ? record.codeHost
      : record.github
        ? {
            integration: 'github',
            repository: record.github.repo,
            changeRequest:
              record.github.pr?.number != null
                ? {
                    number: Number(record.github.pr.number),
                    ...(record.github.pr.url ? { url: record.github.pr.url } : {}),
                  }
                : undefined,
            connectionId: record.github.connectionId,
          }
        : undefined
  if (value === undefined) return { status: 'absent' }
  const result = codeHostReferenceSchema.safeParse(value)
  return result.success
    ? { status: 'valid', reference: result.data }
    : { status: 'invalid', issues: formatCodeHostIssues(result.error) }
}

/** Resolve a usable binding, or null when the metadata carries none or an invalid one. */
export function resolveCodeHostReference(metadata: unknown): CodeHostReference | null {
  const described = describeCodeHostReference(metadata)
  return described.status === 'valid' ? described.reference : null
}
