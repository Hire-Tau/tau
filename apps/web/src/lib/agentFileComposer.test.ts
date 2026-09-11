import { describe, expect, test } from 'bun:test'
import { insertAttachmentReference, removeAttachmentReferences, repairAttachmentReference } from './agentFileComposer'

const REF = '@/private/chat-attachments/6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d/report.pdf'

describe('insertAttachmentReference', () => {
  test.each([
    ['', undefined, `${REF} `, REF.length + 1],
    ['read this', { start: 5, end: 9 }, `read ${REF} `, 6 + REF.length],
    ['before,after', { start: 7, end: 7 }, `before, ${REF} after`, 9 + REF.length],
    ['hello', undefined, `hello ${REF} `, 7 + REF.length],
  ] as const)('inserts with natural spacing', (text, selection, expected, caret) => {
    expect(insertAttachmentReference(text, REF, selection)).toEqual({ text: expected, caret })
  })
})

describe('removeAttachmentReferences', () => {
  test('removes every exact token without touching lookalikes', () => {
    expect(removeAttachmentReferences(`See ${REF}, then ${REF}! Keep ${REF}.extra`, REF)).toBe(
      `See , then ! Keep ${REF}.extra`
    )
  })

  test('preserves unrelated authored whitespace byte-for-byte', () => {
    expect(removeAttachmentReferences(`  lead  ${REF}  tail  `, REF)).toBe('  lead    tail  ')
  })

  test('repairs only remaining exact stale references', () => {
    const canonical = REF.replace('report.pdf', 'canonical.pdf')
    expect(repairAttachmentReference(`x ${REF} ${REF}.extra`, REF, canonical)).toBe(`x ${canonical} ${REF}.extra`)
    expect(repairAttachmentReference('user deleted it', REF, canonical)).toBe('user deleted it')
  })
})
