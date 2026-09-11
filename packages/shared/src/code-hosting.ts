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

/** An explicit canonical binding takes precedence, including when it is invalid. */
export function resolveCodeHostReference(metadata: unknown): CodeHostReference | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
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
  const result = codeHostReferenceSchema.safeParse(value)
  return result.success ? result.data : null
}
