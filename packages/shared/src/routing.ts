export type RoutingEvidenceKind = 'purpose' | 'memory' | 'ownership'

export interface RoutingEvidenceSource {
  sourceSquadId: string
  sourceType: string
  path?: string | null
  title?: string | null
  snippet?: string
}

export interface RoutingEvidence {
  kind: RoutingEvidenceKind
  /** Normalized weighted contribution to the squad's total score. */
  score: number
  /** Provenance for memory/ownership kinds. Absent for purpose. */
  source?: RoutingEvidenceSource
  /** Short human-readable summary, e.g. "Squad purpose matches (0.40)". */
  description: string
}

export interface SquadSuggestion {
  squadId: string
  squadName: string
  /** Total weighted score. */
  score: number
  /** Structured evidence backing the score. */
  evidence: RoutingEvidence[]
  /** Backwards-compatible flat list of evidence descriptions. */
  reasons: string[]
}

export type RoutingRecommendation = 'route' | 'clarify' | 'escalate'

export interface SuggestSquadResponse {
  suggestions: SquadSuggestion[]
  recommendation: RoutingRecommendation
  /** Route confidence is the top suggestion score; zero when no usable candidates exist. */
  confidence: number
  /** Human-readable explanation for the chosen recommendation. */
  reason: string
}
