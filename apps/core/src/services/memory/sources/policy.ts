import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const BaseIngestionPolicy = Type.Object(
  {
    version: Type.Literal(1),
    enabled: Type.Optional(Type.Boolean()),
    scope: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    timeWindowDays: Type.Optional(Type.Integer({ minimum: 1 })),
    minBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    retentionDays: Type.Optional(Type.Integer({ minimum: 1 })),
    defaultSensitivity: Type.Optional(
      Type.Union([
        Type.Literal('public'),
        Type.Literal('internal'),
        Type.Literal('restricted'),
        Type.Literal('confidential'),
      ])
    ),
  },
  { additionalProperties: true }
)

export type BaseIngestionPolicy = Static<typeof BaseIngestionPolicy>

export function validateBaseIngestionPolicy(policy: unknown): string[] | null {
  const errors = [...Value.Errors(BaseIngestionPolicy, policy)].map((error) => {
    const path = error.path.replace(/^\//, '').replaceAll('/', '.') || 'policy'
    return `${path} ${error.message}`
  })
  return errors.length > 0 ? errors : null
}

export function validateStringArrayScope(policy: unknown, key: string, label = `scope.${key}`): string[] | null {
  if (!policy || typeof policy !== 'object') return null
  const scope = (policy as { scope?: unknown }).scope
  if (!scope || typeof scope !== 'object') return null
  const value = (scope as Record<string, unknown>)[key]
  if (value === undefined) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return [`${label} must be an array of strings`]
  }
  return null
}

export function mergePolicyErrors(...groups: (string[] | null | undefined)[]): string[] | null {
  const errors = groups.flatMap((group) => group ?? [])
  return errors.length > 0 ? errors : null
}

export function getPolicyDefaultSensitivity(policy: Record<string, unknown> | null | undefined) {
  const value = policy?.defaultSensitivity
  return value === 'public' || value === 'internal' || value === 'restricted' || value === 'confidential'
    ? value
    : undefined
}
