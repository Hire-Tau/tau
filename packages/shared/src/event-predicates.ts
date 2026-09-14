import { z } from 'zod'
import { integrationDataPathSchema, integrationValueAt } from './integration-outputs'
import { eventPredicateField, type EventPredicateField } from './event-predicate-catalog'

const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()])
export const eventPredicateSchema = z
  .object({
    field: integrationDataPathSchema,
    op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
    value: z.union([scalar, z.array(scalar).min(1).max(100)]),
  })
  .strict()
export type EventPredicate = z.infer<typeof eventPredicateSchema>

export function eventPredicateOperators(field: EventPredicateField): EventPredicate['op'][] {
  if (field.type === 'string[]') return ['contains', 'exists']
  return ['eq', 'neq', 'in', ...(field.type === 'number' ? (['gt', 'gte', 'lt', 'lte'] as const) : []), 'exists']
}
export function validateEventPredicates(
  source: { integration: string; output: string; version: number },
  predicates: EventPredicate[],
  ctx: z.RefinementCtx
) {
  predicates.forEach((predicate, index) => {
    const field = eventPredicateField(source, predicate.field)
    let message: string | undefined
    if (!field) message = 'Unsupported predicate field for this event version'
    else if (!eventPredicateOperators(field).includes(predicate.op)) message = 'Unsupported operator for this field'
    else {
      const type = predicate.op === 'exists' ? 'boolean' : field.type === 'string[]' ? 'string' : field.type
      const values = predicate.op === 'in' ? predicate.value : [predicate.value]
      if (!Array.isArray(values) || !values.every((value) => typeof value === type))
        message = `Predicate requires ${predicate.op === 'in' ? 'an array of ' : ''}${type} operands`
    }
    if (message) ctx.addIssue({ code: 'custom', path: ['predicates', index], message })
  })
}

/** No coercion. Missing/null never satisfy comparisons, including neq. Empty collections are present. */
export function eventPredicateMatches(predicate: EventPredicate, field: EventPredicateField, data: unknown): boolean {
  const actual = integrationValueAt(data, predicate.field)
  if (predicate.op === 'exists') return (actual !== undefined && actual !== null) === predicate.value
  if (actual === undefined || actual === null) return false
  const normalize = (value: unknown) =>
    field.normalize === 'lowercase' && typeof value === 'string' ? value.toLowerCase() : value
  if (field.type === 'string[]')
    return (
      predicate.op === 'contains' &&
      Array.isArray(actual) &&
      actual.every((item) => typeof item === 'string') &&
      actual.some((item) => normalize(item) === normalize(predicate.value))
    )
  if (typeof actual !== field.type || (typeof actual === 'number' && !Number.isFinite(actual))) return false
  const expected = normalize(predicate.value)
  const value = normalize(actual)
  switch (predicate.op) {
    case 'eq':
      return value === expected
    case 'neq':
      return value !== expected
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some((item) => value === normalize(item))
    case 'gt':
      return typeof value === 'number' && typeof expected === 'number' && value > expected
    case 'gte':
      return typeof value === 'number' && typeof expected === 'number' && value >= expected
    case 'lt':
      return typeof value === 'number' && typeof expected === 'number' && value < expected
    case 'lte':
      return typeof value === 'number' && typeof expected === 'number' && value <= expected
    default:
      return false
  }
}
