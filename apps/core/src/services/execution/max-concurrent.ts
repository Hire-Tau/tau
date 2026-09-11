import { createLogger } from '../../lib/infra/logger'

const log = createLogger('max-concurrent')

/**
 * The instance-wide cap on concurrently running agent executions.
 *
 * This module is deliberately PURE — it imports nothing but the logger. The
 * store-reading accessor lives in `pickup.ts` (`getMaxConcurrentAgents`) so
 * that `services/settings/store.ts` can import these constants for its
 * `KNOWN_SETTINGS` entry without an import cycle.
 *
 * Precedence (see `resolveMaxConcurrentAgents`): stored setting > env var >
 * built-in default. The stored setting wins deliberately: every real
 * deployment sets `MAX_CONCURRENT_AGENTS` in its EnvironmentFile, so treating
 * env as the winner would make the UI control a silent no-op exactly where it
 * matters. Env therefore acts as the per-instance DEFAULT — clearing the
 * stored value reverts to it.
 *
 * The two sources are validated differently on purpose: both must be a whole
 * number of at least 1, but only the stored setting is capped at
 * `MAX_MAX_CONCURRENT_AGENTS`. See that constant for the reasoning.
 */

/** Settings key holding the operator-editable cap. */
export const MAX_CONCURRENT_AGENTS_SETTING_KEY = 'MAX_CONCURRENT_AGENTS'

/** Cap used when neither a stored setting nor the env var supplies a valid value. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 30

/**
 * The floor, enforced on EVERY source of a cap (stored setting and env var).
 *
 * It is 1, not 0: a 0 cap silently halts every execution on the instance with
 * no error anywhere — operators who want that should stop the worker, not set
 * a number. A negative cap is worse still, and `Number(env) || 30` used to
 * produce one verbatim for `MAX_CONCURRENT_AGENTS=-3`.
 */
export const MIN_MAX_CONCURRENT_AGENTS = 1

/**
 * The ceiling, enforced ONLY on the stored (UI-editable) setting — deliberately
 * NOT on the env var.
 *
 * It is a blunt sanity guard against the cluster-saturation failure mode: a
 * fat-fingered 3000 typed into a web form pins every node's CPU requests and
 * strands agents in Pending. That is a hazard of the new, low-ceremony input
 * surface this setting adds.
 *
 * `MAX_CONCURRENT_AGENTS` is not that surface. It is set once by an operator in
 * an EnvironmentFile, next to the CPU and memory sizing it has to agree with,
 * and it is already live on deployed instances. Clamping it here would cut an
 * instance running `MAX_CONCURRENT_AGENTS=1000` down to 30 the moment this
 * feature ships — a 33x capacity reduction nobody asked for, appearing on a
 * deploy whose changelog says "added a setting". Logging the clamp would make
 * it diagnosable but would not make it wanted. So env passes through: with
 * nothing stored, the effective cap is unchanged from the pre-setting
 * behaviour for every value that behaviour accepted.
 */
export const MAX_MAX_CONCURRENT_AGENTS = 500

/**
 * Parse a cap from an operator-set source (i.e. the env var): a whole number of
 * at least `MIN_MAX_CONCURRENT_AGENTS`, or `null`. Never returns a number for
 * input it dislikes, so no caller can accidentally fall through to `0` (which
 * `Number(x) || d` style parsing makes disturbingly easy).
 *
 * No ceiling — see `MAX_MAX_CONCURRENT_AGENTS`.
 */
function parseUnboundedCap(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  if (!Number.isInteger(value)) return null
  if (value < MIN_MAX_CONCURRENT_AGENTS) return null
  return value
}

/**
 * Parse a candidate cap for the STORED setting — the value an operator types
 * into the settings UI. Bounded at both ends; see the two bound constants for
 * why only this side gets a ceiling.
 */
export function parseMaxConcurrentAgents(raw: string | null | undefined): number | null {
  const value = parseUnboundedCap(raw)
  if (value === null || value > MAX_MAX_CONCURRENT_AGENTS) return null
  return value
}

/** Human-readable rejection reason, or `null` when `value` is acceptable. */
export function maxConcurrentAgentsError(value: string): string | null {
  if (parseMaxConcurrentAgents(value) !== null) return null
  return `${MAX_CONCURRENT_AGENTS_SETTING_KEY} must be a whole number between ${MIN_MAX_CONCURRENT_AGENTS} and ${MAX_MAX_CONCURRENT_AGENTS} (got '${value}')`
}

/**
 * Resolve the effective cap: stored > env > default.
 *
 * `envValue` is a parameter (defaulting to a LIVE `process.env` read) purely so
 * precedence is testable without re-importing anything. An invalid stored
 * value is logged and skipped rather than honoured — a malformed row must
 * degrade to the previous behaviour, never to 0.
 */
export function resolveMaxConcurrentAgents(
  stored: string | null | undefined,
  envValue: string | undefined = process.env.MAX_CONCURRENT_AGENTS
): number {
  const fromStore = parseMaxConcurrentAgents(stored)
  if (fromStore !== null) return fromStore

  if (stored !== null && stored !== undefined && stored.trim() !== '') {
    log.warn(
      `Ignoring invalid stored ${MAX_CONCURRENT_AGENTS_SETTING_KEY} '${stored}'; falling back to the environment/default cap`
    )
  }

  // Unbounded above: the env var is operator-set, not user-set.
  return parseUnboundedCap(envValue) ?? DEFAULT_MAX_CONCURRENT_AGENTS
}

/**
 * The cap that applies when nothing is stored — i.e. the value the settings UI
 * shows as this instance's default and reverts to on delete.
 */
export function envMaxConcurrentAgents(): number {
  return resolveMaxConcurrentAgents(undefined)
}
