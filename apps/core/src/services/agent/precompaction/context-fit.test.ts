import { describe, it, expect } from 'bun:test'
import {
  clampPreparationForBudget,
  estimateSummarizeTokens,
  summarizeInputBudget,
  type CompactionPreparation,
} from './context-fit'

function prep(over: Partial<CompactionPreparation> = {}): CompactionPreparation {
  return {
    firstKeptEntryId: 'keep',
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 0,
    fileOps: { created: [], modified: [], deleted: [], read: [] },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    ...over,
  } as CompactionPreparation
}

function userMsg(text: string) {
  return { role: 'user', content: text, timestamp: 1 } as CompactionPreparation['messagesToSummarize'][number]
}

describe('estimateSummarizeTokens', () => {
  it('estimates ~chars/4 over the serialized conversation', () => {
    const p = prep({ messagesToSummarize: [userMsg('x'.repeat(4_000))] })
    const tokens = estimateSummarizeTokens(p)
    // "[User]: " + 4000 chars ⇒ slightly over 1000 tokens
    expect(tokens).toBeGreaterThanOrEqual(1_000)
    expect(tokens).toBeLessThan(1_100)
  })

  it('includes turn prefix messages and the previous summary', () => {
    const base = estimateSummarizeTokens(prep({ messagesToSummarize: [userMsg('x'.repeat(4_000))] }))
    const withExtras = estimateSummarizeTokens(
      prep({
        messagesToSummarize: [userMsg('x'.repeat(4_000))],
        turnPrefixMessages: [userMsg('y'.repeat(4_000))],
        previousSummary: 'z'.repeat(4_000),
      })
    )
    expect(withExtras).toBeGreaterThan(base + 1_800)
  })

  it('counts bashExecution messages toward the estimate (convertToLlm pipeline)', () => {
    const base = estimateSummarizeTokens(prep())
    const output = 'x'.repeat(4_000)
    const withBash = estimateSummarizeTokens(
      prep({
        messagesToSummarize: [
          {
            role: 'bashExecution',
            command: 'echo hi',
            output,
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 1,
          } as CompactionPreparation['messagesToSummarize'][number],
        ],
      })
    )
    // ~4000 chars of output ⇒ roughly 1000 tokens added over the empty baseline.
    expect(withBash - base).toBeGreaterThanOrEqual(800)
    expect(withBash - base).toBeLessThan(1_300)
  })
})

describe('summarizeInputBudget', () => {
  it('leaves room for the response and estimation error', () => {
    const budget = summarizeInputBudget({ contextWindow: 272_000, maxTokens: 128_000 }, { reserveTokens: 16_384 })
    // response = min(0.8*16384, 128000) = 13107; (272000-13107)*0.85 - 4000 ≈ 216_059
    expect(budget).toBeGreaterThan(200_000)
    expect(budget).toBeLessThan(272_000 - 13_107)
  })

  it('never goes negative for tiny windows', () => {
    expect(summarizeInputBudget({ contextWindow: 4_000, maxTokens: 1_000 }, { reserveTokens: 16_384 })).toBe(0)
  })
})

function assistantWithToolCall(argChars: number) {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'writing file' },
      { type: 'thinking', thinking: 't'.repeat(argChars) },
      { type: 'toolCall', id: 'tc1', name: 'write', arguments: { path: '/a.ts', content: 'c'.repeat(argChars) } },
    ],
    timestamp: 1,
  } as CompactionPreparation['messagesToSummarize'][number]
}

describe('clampPreparationForBudget', () => {
  it('returns the same object untouched when it already fits', () => {
    const p = prep({ messagesToSummarize: [userMsg('short')] })
    expect(clampPreparationForBudget(p, 10_000)).toBe(p)
  })

  it('clamps tool-call arguments and thinking without mutating the input', () => {
    const p = prep({ messagesToSummarize: [assistantWithToolCall(100_000)] })
    const before = estimateSummarizeTokens(p)
    const clamped = clampPreparationForBudget(p, 5_000)
    expect(clamped).not.toBe(p)
    expect(estimateSummarizeTokens(clamped)).toBeLessThanOrEqual(5_000)
    // Input preparation untouched
    expect(estimateSummarizeTokens(p)).toBe(before)
    const block = (
      clamped.messagesToSummarize[0] as { content: Array<{ type: string; arguments?: { content?: string } }> }
    ).content[2]
    expect(String(block.arguments?.content)).toContain('truncated')
  })

  it('tightens text blocks when arg clamping is not enough', () => {
    const p = prep({ messagesToSummarize: [userMsg('x'.repeat(400_000))] })
    const clamped = clampPreparationForBudget(p, 2_000)
    expect(estimateSummarizeTokens(clamped)).toBeLessThanOrEqual(2_000)
  })

  it('drops oldest messages as a last resort and records a note', () => {
    const many = Array.from({ length: 40 }, (_, i) => userMsg(`m${i} ` + 'x'.repeat(8_000)))
    const p = prep({ messagesToSummarize: many })
    const clamped = clampPreparationForBudget(p, 1_500)
    expect(estimateSummarizeTokens(clamped)).toBeLessThanOrEqual(1_500)
    const first = clamped.messagesToSummarize[0] as { role: string; content: string }
    expect(first.role).toBe('user')
    expect(String(first.content)).toContain('omitted')
    // firstKeptEntryId is untouched — dropped messages only vanish from the
    // summary input, never from the session file or the kept context.
    expect(clamped.firstKeptEntryId).toBe('keep')
    // Tight boundary: the note itself must not push the result over budget.
    const tightPrep = prep({
      messagesToSummarize: [
        userMsg('m0 ' + 'x'.repeat(1_200)),
        userMsg('m1 ' + 'x'.repeat(1_200)),
        userMsg('m2 ' + 'x'.repeat(1_200)),
      ],
    })
    const tight = clampPreparationForBudget(tightPrep, 350)
    expect(estimateSummarizeTokens(tight)).toBeLessThanOrEqual(350)
  })

  it('caps a lone oversized bashExecution message via the text-clamp rungs', () => {
    // A single bashExecution message can't be shrunk by clampToolArgsAndThinking
    // (assistant-only) or by the drop-oldest-half rung (needs >1 message to
    // drop anything) — only the text-cap rungs reaching bashExecution.output
    // can bring this under budget.
    const p = prep({
      messagesToSummarize: [
        {
          role: 'bashExecution',
          command: 'cat huge.log',
          output: 'x'.repeat(400_000),
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        } as CompactionPreparation['messagesToSummarize'][number],
      ],
    })
    const clamped = clampPreparationForBudget(p, 2_000)
    expect(estimateSummarizeTokens(clamped)).toBeLessThanOrEqual(2_000)
    const bash = clamped.messagesToSummarize[0] as { output: string }
    expect(bash.output).toContain('truncated')
    expect(bash.output.length).toBeLessThan(400_000)
  })

  it('truncates an oversized previousSummary as the final rung', () => {
    // messagesToSummarize is tiny (one short message, nothing to clamp or
    // drop), so only the final previousSummary rung can bring this under
    // budget — proving previousSummary is now clamped, not just estimated.
    const p = prep({
      messagesToSummarize: [userMsg('short')],
      previousSummary: 'z'.repeat(400_000),
    })
    const clamped = clampPreparationForBudget(p, 1_000)
    expect(estimateSummarizeTokens(clamped)).toBeLessThanOrEqual(1_000)
    expect(clamped.previousSummary).toContain('truncated')
    expect(clamped.previousSummary?.length).toBeLessThan(2_100)
    // Confirms the fit came from truncating previousSummary, not from
    // dropping/noting messagesToSummarize (which has only one entry).
    expect(clamped.messagesToSummarize).toHaveLength(1)
    expect((clamped.messagesToSummarize[0] as { content: string }).content).toBe('short')
  })
})
