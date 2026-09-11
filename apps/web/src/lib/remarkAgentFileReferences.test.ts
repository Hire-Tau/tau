import { describe, expect, test } from 'bun:test'
import { remarkAgentFileReferences } from './remarkAgentFileReferences'

const ID = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
const REF = `@/private/chat-attachments/${ID}/report.pdf`

describe('remarkAgentFileReferences', () => {
  test('splits exact text references into authenticated attachment links', () => {
    const tree: any = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: `See ${REF}.` }] }],
    }
    remarkAgentFileReferences({ agentId: 'agent-id' })(tree)
    expect(tree.children[0].children).toEqual([
      { type: 'text', value: 'See ' },
      expect.objectContaining({
        type: 'link',
        url: `/api/agents/agent-id/files/${ID}`,
        data: { hProperties: { 'data-agent-file-id': ID, 'data-agent-file-name': 'report.pdf' } },
      }),
      { type: 'text', value: '.' },
    ])
  })

  test('leaves code and existing links unchanged', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'inlineCode', value: REF },
        { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: REF }] },
      ],
    }
    remarkAgentFileReferences({ agentId: 'agent-id' })(tree)
    expect(tree.children[0]).toEqual({ type: 'inlineCode', value: REF })
    expect(tree.children[1].children).toEqual([{ type: 'text', value: REF }])
  })
})
