export type EntityReference = { kind: 'ws' | 'agent'; id: string }

/** Explicit Tau references only; never reinterpret arbitrary URLs or partial IDs. */
export function parseEntityReference(value: string | undefined): EntityReference | null {
  const match = value?.match(/^tau:(ws|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return match ? { kind: match[1]!.toLowerCase() as EntityReference['kind'], id: match[2]!.toLowerCase() } : null
}
