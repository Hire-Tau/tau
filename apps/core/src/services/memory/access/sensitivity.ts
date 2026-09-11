export type SensitivityTier = 'public' | 'internal' | 'restricted' | 'confidential'

const ORDER: Record<SensitivityTier, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
  confidential: 3,
}

const VALID = new Set(Object.keys(ORDER))

export function compareSensitivity(a: SensitivityTier, b: SensitivityTier): number {
  return ORDER[a] - ORDER[b]
}

export function isAllowedBy(docTier: SensitivityTier, ceiling: SensitivityTier | undefined): boolean {
  if (ceiling === undefined) return true
  return compareSensitivity(docTier, ceiling) <= 0
}

export function parseSensitivity(value: unknown): SensitivityTier {
  if (typeof value === 'string' && VALID.has(value)) return value as SensitivityTier
  return 'internal'
}
