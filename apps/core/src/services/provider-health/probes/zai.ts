import { getModels } from '@earendil-works/pi-ai/compat'
import type { HealthProbe, ProbeResult } from './types'

interface ZaiQuotaLimit {
  type?: string
  remaining?: number
  nextResetTime?: number
}

interface ZaiQuotaResponse {
  code?: number | string
  msg?: string
  success?: boolean
  data?: {
    limits?: ZaiQuotaLimit[]
  }
}

interface ZaiApiErrorResponse {
  code?: number | string
  msg?: string
  message?: string
  error?: {
    code?: number | string
    message?: string
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const secs = Number(trimmed)
  if (!Number.isNaN(secs) && trimmed.length > 0) return Date.now() + secs * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : date
}

/**
 * Resolve the z.ai monitor API host from the Pi SDK model base URL. The model
 * base URL includes the coding API path (e.g.
 * `https://api.z.ai/api/coding/paas/v4`); the quota endpoint lives at the host
 * root (`https://api.z.ai/api/monitor/usage/quota/limit`).
 */
function quotaHost(override?: string): string {
  const raw = override ?? getModels('zai').find((x) => x.baseUrl)?.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4'
  try {
    const url = new URL(raw)
    return url.origin
  } catch {
    return 'https://api.z.ai'
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  const authorization = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`
  return { Authorization: authorization, Accept: 'application/json' }
}

function bodyText(body: ZaiApiErrorResponse): string {
  return [body.code, body.msg, body.message, body.error?.code, body.error?.message]
    .filter((x) => x !== undefined && x !== null)
    .join(' ')
    .toLowerCase()
}

function isMissingCodingPlan(body: ZaiQuotaResponse): boolean {
  const text = bodyText(body)
  return (
    text.includes('coding plan') &&
    (text.includes('不存在') || text.includes('not exist') || text.includes('no coding'))
  )
}

function isTokenLimit(limit: ZaiQuotaLimit): boolean {
  return limit.type === undefined || limit.type === 'TOKENS_LIMIT'
}

async function readJson(res: Response): Promise<ZaiApiErrorResponse> {
  return (await res.json().catch(() => ({}))) as ZaiApiErrorResponse
}

export const zaiProbe: HealthProbe = {
  provider: 'zai',
  async probe({ apiKey, baseUrl: override }: { apiKey?: string; baseUrl?: string } = {}): Promise<ProbeResult> {
    if (!apiKey) return { state: 'inconclusive' } // local auth resolution is not provider success

    const res = await fetch(`${quotaHost(override)}/api/monitor/usage/quota/limit`, {
      headers: authHeaders(apiKey),
    })

    if (res.status === 429) {
      return {
        state: 'unhealthy',
        kind: 'rate-limit',
        retryAt: parseRetryAfter(res.headers.get('retry-after')),
        status: 429,
      }
    }
    if (res.status === 401 || res.status === 403)
      return { state: 'unhealthy', kind: 'invalid-credential', status: res.status }
    if (res.status >= 500) return { state: 'inconclusive', status: res.status }
    if (!res.ok) return { state: 'unhealthy', kind: 'error', status: res.status }

    const body = (await readJson(res)) as ZaiQuotaResponse
    if (body.success !== true) {
      if (isMissingCodingPlan(body)) return { state: 'inconclusive', status: res.status }
      return { state: 'unhealthy', kind: 'error', status: res.status }
    }

    const depleted = body.data?.limits?.find(
      (limit) => isTokenLimit(limit) && typeof limit.remaining === 'number' && limit.remaining <= 0
    )
    if (depleted) {
      return { state: 'unhealthy', kind: 'plan-credit', retryAt: depleted.nextResetTime, status: res.status }
    }

    return { state: 'healthy', status: res.status }
  },
}
