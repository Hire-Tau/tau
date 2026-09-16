import { describe, expect, test } from 'bun:test'
import {
  ATTENTION_KINDS,
  ATTENTION_LEVELS,
  DEFAULT_ATTENTION,
  WATCH_ATTENTION,
  attentionSchema,
  hasNotify,
  parseAttention,
  summarizeAttention,
} from './attention'

describe('attention vocabulary', () => {
  test('two kinds and one three-point level scale, in escalating order', () => {
    expect(ATTENTION_KINDS).toEqual(['decisions', 'progress'])
    expect(ATTENTION_LEVELS).toEqual(['mute', 'show', 'notify'])
  })

  test('no row shows everything and interrupts nothing; a plain watch notifies for both kinds', () => {
    expect(DEFAULT_ATTENTION).toEqual({ decisions: 'show', progress: 'show' })
    expect(WATCH_ATTENTION).toEqual({ decisions: 'notify', progress: 'notify' })
  })

  test('the schema requires both kinds and rejects unknown keys and unknown levels', () => {
    expect(attentionSchema.safeParse({ decisions: 'mute', progress: 'notify' }).success).toBe(true)
    expect(attentionSchema.safeParse({ decisions: 'mute' }).success).toBe(false)
    expect(attentionSchema.safeParse({ decisions: 'mute', progress: 'notify', extra: 1 }).success).toBe(false)
    expect(attentionSchema.safeParse({ decisions: 'loud', progress: 'notify' }).success).toBe(false)
  })

  test('parseAttention keeps a valid stored value and falls back to watch for anything else', () => {
    expect(parseAttention({ decisions: 'mute', progress: 'show' })).toEqual({ decisions: 'mute', progress: 'show' })
    // A row EXISTS whenever we parse, so a corrupt or pre-migration value means "watching".
    for (const broken of [null, undefined, 'notify', {}, { decisions: 'mute' }, { decisions: 1, progress: 2 }]) {
      expect(parseAttention(broken)).toEqual(WATCH_ATTENTION)
    }
  })

  test('hasNotify is true when either kind notifies', () => {
    expect(hasNotify({ decisions: 'notify', progress: 'mute' })).toBe(true)
    expect(hasNotify({ decisions: 'mute', progress: 'notify' })).toBe(true)
    expect(hasNotify(DEFAULT_ATTENTION)).toBe(false)
    expect(hasNotify({ decisions: 'mute', progress: 'mute' })).toBe(false)
  })

  test('summarizeAttention collapses equal kinds and reports a mix as custom', () => {
    expect(summarizeAttention(WATCH_ATTENTION)).toBe('notify')
    expect(summarizeAttention(DEFAULT_ATTENTION)).toBe('show')
    expect(summarizeAttention({ decisions: 'mute', progress: 'mute' })).toBe('mute')
    expect(summarizeAttention({ decisions: 'notify', progress: 'mute' })).toBe('custom')
  })
})
