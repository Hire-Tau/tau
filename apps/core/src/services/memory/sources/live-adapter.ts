import type { AllowedScope } from '../access/scope-expander'
import type { SensitivityTier } from '../access/sensitivity'
import type { SourceCapabilities } from './adapter'

export interface LiveSearchScope {
  /** Subset of AllowedScope[] already narrowed to this adapter's sourceType. */
  scopes: AllowedScope[]
  /** Caller squad — for audit + provenance. */
  callerSquadId: string
  /** Per-call deadline. */
  deadlineMs: number
}

export interface LiveSearchResult {
  sourceSquadId: string
  sourceType: string
  sourceId: string
  title: string | null
  snippet: string
  score: number
  sensitivity: SensitivityTier
  /** Source-specific provenance (URL, channel, project, error details, etc.). */
  provenance: Record<string, unknown>
  /** Event-shape, if applicable. */
  event?: { ts: string; actor?: string }
}

export interface LiveMemorySourceAdapter {
  readonly sourceType: string
  /** Must include both `live` and `searchable`. */
  readonly capabilities: SourceCapabilities
  readonly defaultSensitivity: SensitivityTier
  /** Hard upper bound for a single live search call. */
  readonly timeoutMs: number
  /** Adapter call budget. Enforced by SearchService before invoking search(). */
  readonly rateLimit: { perMinute: number }
  search(query: string, opts: LiveSearchScope): Promise<LiveSearchResult[]>
  validateGrantFilter?(filter: unknown): string[] | null
}

export function isLiveMemorySourceAdapter(value: unknown): value is LiveMemorySourceAdapter {
  if (!value || typeof value !== 'object') return false
  const adapter = value as Partial<LiveMemorySourceAdapter>
  return (
    typeof adapter.sourceType === 'string' &&
    typeof adapter.search === 'function' &&
    typeof adapter.timeoutMs === 'number' &&
    !!adapter.rateLimit &&
    adapter.capabilities?.has('live') === true &&
    adapter.capabilities.has('searchable') === true
  )
}
