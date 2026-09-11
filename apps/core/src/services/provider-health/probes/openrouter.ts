import type { HealthProbe, ProbeResult } from './types'

/** Credits use the versioned REST API, independently of model inference endpoints. */
function baseUrl(override?: string): string {
  return (override ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
}

/**
 * OpenRouter credits probe. `GET {baseUrl}/credits` with the bearer API key.
 *
 * Mapping:
 *  - 401/403 → error (auth misconfigured — don't flap, but signal unhealthy)
 *  - 429     → rate-limit
 *  - 402     → plan-credit
 *  - `total_credits <= 0` → plan-credit (insufficient balance)
 *  - otherwise → healthy
 *
 * No API key configured → returns `{ healthy: true }` (no signal; the reactive
 * error path and other providers still function). Probes never spend tokens.
 */
export const openRouterProbe: HealthProbe = {
  provider: 'openrouter',
  async probe({ apiKey, baseUrl: override }: { apiKey?: string; baseUrl?: string } = {}): Promise<ProbeResult> {
    if (!apiKey) return { state: 'inconclusive' } // local auth resolution is not provider success
    const base = baseUrl(override)
    const res = await fetch(`${base}/credits`, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (res.status === 429) return { state: 'unhealthy', kind: 'rate-limit', status: 429 }
    if (res.status === 401 || res.status === 403)
      return { state: 'unhealthy', kind: 'invalid-credential', status: res.status }
    if (res.status === 402) return { state: 'unhealthy', kind: 'plan-credit', status: 402 }
    if (res.status >= 500) return { state: 'inconclusive', status: res.status }
    if (!res.ok) return { state: 'unhealthy', kind: 'error', status: res.status }

    const body = (await res.json().catch(() => ({}))) as { data?: { total_credits?: number } }
    const credits = body?.data?.total_credits
    if (typeof credits === 'number' && credits <= 0) {
      return { state: 'unhealthy', kind: 'plan-credit', status: 200 }
    }
    return { state: 'healthy', status: 200 }
  },
}
