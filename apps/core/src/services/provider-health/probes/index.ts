import type { HealthProbe } from './types'
import { anthropicProbe } from './anthropic'
import { openRouterProbe } from './openrouter'
import { zaiProbe } from './zai'

export type { HealthProbe, ProbeResult, ProbeContext } from './types'

/**
 * Registered per-provider probes. Providers without an entry stay on the
 * reactive (error-based) health path. Add new probes here as providers expose
 * credit/quota endpoints.
 *
 * openai-codex: No probe registered. Its base URL
 * (`https://chatgpt.com/backend-api`) is the ChatGPT backend API using
 * JWT-based session auth, not the standard OpenAI API. No token-free health
 * check endpoint exists. Health signals come from the reactive error path and
 * the onResponse header signal (`classifyResponseHeaders`).
 */
const PROBES = new Map<string, HealthProbe>([
  [anthropicProbe.provider, anthropicProbe],
  [openRouterProbe.provider, openRouterProbe],
  [zaiProbe.provider, zaiProbe],
])

/** Get the registered probe for a provider, if any. */
export function getProbe(provider: string): HealthProbe | undefined {
  return PROBES.get(provider)
}

/** Providers that have an active probe registered. */
export function registeredProbeProviders(): string[] {
  return Array.from(PROBES.keys())
}
