import { ATTENTION_LEVELS, WATCH_ATTENTION, type Attention, type AttentionLevel } from '@tau/shared'

export interface AttentionFlags {
  decisions?: string
  progress?: string
}

export interface SubscriptionResponse {
  subscribed: boolean
  count: number
  attention: Attention
  inherited?: boolean
}

function parseLevel(flag: '--decisions' | '--progress', value: string | undefined): AttentionLevel | undefined {
  if (value === undefined) return undefined
  if ((ATTENTION_LEVELS as readonly string[]).includes(value)) return value as AttentionLevel
  throw new Error(`${flag} must be one of ${ATTENTION_LEVELS.join(', ')}`)
}

export function parseAttentionFlags(flags: AttentionFlags): Partial<Attention> {
  const decisions = parseLevel('--decisions', flags.decisions)
  const progress = parseLevel('--progress', flags.progress)
  return { ...(decisions ? { decisions } : {}), ...(progress ? { progress } : {}) }
}

/**
 * The levels to send. No flag at all means "send nothing": the server inserts WATCH_ATTENTION on a
 * new row and leaves an existing row's levels alone. One flag keeps the other kind at its current
 * value (or notify, on a row that does not exist yet).
 */
export function resolveAttentionUpdate(
  current: Attention | undefined,
  subscribed: boolean,
  flags: AttentionFlags
): Attention | undefined {
  const requested = parseAttentionFlags(flags)
  if (requested.decisions === undefined && requested.progress === undefined) return undefined
  const base = subscribed && current ? current : WATCH_ATTENTION
  return { ...base, ...requested }
}

export function describeAttention(attention: Attention, opts: { inherited?: boolean } = {}): string {
  const inherited = opts.inherited ? ' (inherited from the squad)' : ''
  return `decisions: ${attention.decisions}, progress: ${attention.progress}${inherited}`
}
