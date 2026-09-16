import { z } from 'zod'

/**
 * Attention levels. "Watching" used to be one boolean doing two unrelated jobs: it made you an
 * attention recipient for a squad's questions and waits, AND it subscribed you to every work
 * stream's completion notices. This splits those into two KINDS, each carrying the same
 * three-point LEVEL scale, per squad and per work stream:
 *
 *   decisions — anything that needs a human: agent questions, review waits, manual (blocked)
 *               waits, halted agents. These are the "Needs you" items.
 *   progress  — informational activity: a stream's presence in the feed's active-work list and
 *               its completion notice.
 *
 * Levels: `mute` (not even displayed), `show` (displayed, never interrupts), `notify` (displayed,
 * inbox message, and push — push still subject to the user's master toggle and category mutes).
 *
 * Precedence for a user on a stream: the stream's row, else the squad's row, else
 * DEFAULT_ATTENTION. Permissions are resolved first and independently; attention only narrows.
 */
export const ATTENTION_KINDS = ['decisions', 'progress'] as const
export const ATTENTION_LEVELS = ['mute', 'show', 'notify'] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number]

export const attentionSchema = z
  .object({
    decisions: z.enum(ATTENTION_LEVELS),
    progress: z.enum(ATTENTION_LEVELS),
  })
  .strict()

export type Attention = z.infer<typeof attentionSchema>

/** No subscription row: everything you can reach is visible, nothing interrupts. */
export const DEFAULT_ATTENTION: Attention = { decisions: 'show', progress: 'show' }

/** A plain subscribe/watch with no explicit levels — the historical watch semantics. */
export const WATCH_ATTENTION: Attention = { decisions: 'notify', progress: 'notify' }

/**
 * Read a stored attention value. Anything unreadable falls back to WATCH_ATTENTION rather than
 * DEFAULT_ATTENTION: we only ever parse when a row EXISTS, and a row means the user asked to be
 * subscribed. Failing to the quieter value would silently unsubscribe people on a bad write.
 */
export function parseAttention(value: unknown): Attention {
  const parsed = attentionSchema.safeParse(value)
  return parsed.success ? parsed.data : WATCH_ATTENTION
}

/** True when either kind asks for an inbox message + push. */
export function hasNotify(attention: Attention): boolean {
  return attention.decisions === 'notify' || attention.progress === 'notify'
}

/** One-word summary for a menu trigger: both kinds equal collapse to that level, a mix is custom. */
export function summarizeAttention(attention: Attention): AttentionLevel | 'custom' {
  return attention.decisions === attention.progress ? attention.decisions : 'custom'
}
