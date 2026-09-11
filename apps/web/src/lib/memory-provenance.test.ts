import { describe, expect, it } from 'bun:test'
import { parseMemoryProvenance, stripProvenanceBlock } from './memory-provenance'

const block =
  '<!--tau:memory-provenance [{"sourceSquadId":"squad-aaaa","path":"/memory/a.md","title":"A","sourceType":"memory_file","sensitivity":"internal","score":0.9,"documentId":"d1"}] -->'

describe('parseMemoryProvenance', () => {
  it('extracts the provenance array', () => {
    const result = `Found 1 result(s):\n\n**1. /memory/a.md**\n${block}`
    const p = parseMemoryProvenance(result)
    expect(p).toHaveLength(1)
    expect(p![0].sourceSquadId).toBe('squad-aaaa')
    expect(p![0].sensitivity).toBe('internal')
  })

  it('returns null when no block is present', () => {
    expect(parseMemoryProvenance('No matching documents found.')).toBeNull()
  })

  it('returns null on malformed JSON (fails closed)', () => {
    expect(parseMemoryProvenance('<!--tau:memory-provenance [not json] -->')).toBeNull()
  })
})

describe('stripProvenanceBlock', () => {
  it('removes the comment so human text renders clean', () => {
    expect(stripProvenanceBlock(`hi\n${block}`).trim()).toBe('hi')
  })
})
