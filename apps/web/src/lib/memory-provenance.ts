export interface MemoryProvenanceEntry {
  documentId: string
  sourceSquadId: string
  sourceType: string | null
  sensitivity: string
  path: string | null
  title: string | null
  score: number
  url?: string
}

const BLOCK_RE = /<!--tau:memory-provenance\s+(\[[\s\S]*?\])\s*-->/

export function parseMemoryProvenance(result: string): MemoryProvenanceEntry[] | null {
  const match = result.match(BLOCK_RE)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[1])
    if (!Array.isArray(parsed)) return null
    return parsed as MemoryProvenanceEntry[]
  } catch {
    return null
  }
}

export function stripProvenanceBlock(result: string): string {
  return result.replace(BLOCK_RE, '')
}
