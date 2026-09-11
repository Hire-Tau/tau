import { describe, expect, it } from 'bun:test'
import { createImDoneTool, type CompletionSignal } from './subagent-completion'

describe('im_done', () => {
  it('records an explicit completed result and returns confirmation', async () => {
    const signal: CompletionSignal = { requested: false }
    const tool = createImDoneTool({ signal })

    const result = await tool.execute('call-1', { result: 'Final answer' }, undefined, undefined, {} as any)

    expect(signal).toEqual({ requested: true, result: 'Final answer', status: 'completed' })
    expect((result.content[0] as any).text).toContain('Final result recorded')
    expect((result.content[0] as any).text).toContain('parent will receive this as your conclusory message')
  })

  it('records blocked status when provided', async () => {
    const signal: CompletionSignal = { requested: false }
    const tool = createImDoneTool({ signal })

    await tool.execute(
      'call-1',
      { result: 'Blocked because credentials are missing', status: 'blocked' },
      undefined,
      undefined,
      {} as any
    )

    expect(signal).toEqual({
      requested: true,
      result: 'Blocked because credentials are missing',
      status: 'blocked',
    })
  })
})
