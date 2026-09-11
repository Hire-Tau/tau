import { createLogger } from '../../lib/infra/logger'

const log = createLogger('concurrency-config')

/** Configured limits. Keys are bare provider (`zai`) or `provider/modelId`. */
export type ConcurrencyLimits = Record<string, number>

/** Built-in limits for providers with known hard concurrency caps. */
export const DEFAULT_PROVIDER_CONCURRENCY_LIMITS: ConcurrencyLimits = {
  zai: 10, // Z.ai GLM-5.x supports ~10 concurrent in-flight agents
}

/** Most-specific-key-wins: model-level overrides provider-level. */
export function getLimit(limits: ConcurrencyLimits, provider: string, modelId?: string): number | undefined {
  if (provider && modelId) {
    const modelKey = `${provider}/${modelId}`
    if (limits[modelKey] != null) return limits[modelKey]
  }
  if (limits[provider] != null) return limits[provider]
  return undefined
}

/**
 * Resolve effective limits: defaults merged with the PROVIDER_CONCURRENCY_LIMITS
 * env var (JSON object). Malformed or invalid env values fall back to defaults.
 */
export function resolveLimits(): ConcurrencyLimits {
  const merged: ConcurrencyLimits = { ...DEFAULT_PROVIDER_CONCURRENCY_LIMITS }
  const raw = process.env.PROVIDER_CONCURRENCY_LIMITS
  if (!raw) return merged

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('PROVIDER_CONCURRENCY_LIMITS is not a JSON object; ignoring')
      return merged
    }

    for (const [key, value] of Object.entries(parsed)) {
      const num = Number(value)
      if (Number.isInteger(num) && num > 0) {
        merged[key] = num
      } else {
        log.warn(`Ignoring invalid concurrency limit '${key}': ${String(value)}`)
      }
    }
  } catch (err) {
    log.warn('Failed to parse PROVIDER_CONCURRENCY_LIMITS; using defaults only:', err)
  }

  return merged
}
