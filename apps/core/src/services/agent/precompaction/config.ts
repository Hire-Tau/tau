/**
 * Pure configuration helpers for seamless async pre-compaction.
 *
 * The "early threshold" mirrors pi's own compaction trigger
 * (`contextTokens > contextWindow - reserveTokens`) shifted down by a fixed
 * token margin, so the background summary has runway to finish before pi
 * compacts. The margin is absolute tokens (not a percentage): the runway
 * between "start baking" and "pi compacts" is exactly `marginTokens` on every
 * context-window size.
 */

/** Default early margin when an agent type does not specify one. */
export const DEFAULT_EARLY_MARGIN_TOKENS = 24_576

/**
 * Default in-flight (mid-turn) margin when an agent type does not specify one.
 * This is intentionally smaller than the settled-turn margin so the mid-turn
 * trigger fires closer to pi's synchronous compaction threshold.
 */
export const DEFAULT_IN_FLIGHT_MARGIN_TOKENS = 8192

/**
 * Resolve a raw (yaml/DB) margin into an effective margin in tokens.
 * `null`/`undefined`/non-finite ⇒ the default. The HTTP API and config-sync
 * validation reject negatives; `0` is the supported way to hard-disable
 * pre-compaction. The `<= 0` check in `earlyThresholdReached` is a defensive
 * backstop.
 */
export function resolveEarlyMarginTokens(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_EARLY_MARGIN_TOKENS
  }
  return Math.floor(raw)
}

/**
 * Resolve a raw (yaml/DB) in-flight margin into an effective margin in tokens.
 * It has the same semantics as the early margin: null/undefined/non-finite
 * values use the default, and callers treat <=0 as disabled.
 */
export function resolveInFlightMarginTokens(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_IN_FLIGHT_MARGIN_TOKENS
  }
  return Math.floor(raw)
}

/**
 * Whether context usage has crossed the early (pre-bake) threshold.
 * A non-positive margin hard-disables pre-compaction.
 */
export function earlyThresholdReached(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
  marginTokens: number
): boolean {
  if (marginTokens <= 0) return false
  return contextTokens > contextWindow - reserveTokens - marginTokens
}
