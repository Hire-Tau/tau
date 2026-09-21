import { describe, expect, test } from 'bun:test'
import {
  ATTENTION_KINDS,
  ATTENTION_KIND_COPY,
  ATTENTION_LEVELS,
  ATTENTION_LEVEL_COPY,
  DEFAULT_ATTENTION,
  WATCH_ATTENTION,
  attentionSchema,
  describeAttentionLevel,
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

  test('every kind and every level carries copy, and each kind describes its own surface', () => {
    for (const kind of ATTENTION_KINDS) {
      expect(ATTENTION_KIND_COPY[kind].label.length).toBeGreaterThan(0)
      expect(ATTENTION_KIND_COPY[kind].helper.length).toBeGreaterThan(0)
      for (const level of ATTENTION_LEVELS) {
        expect(ATTENTION_LEVEL_COPY[kind][level].length).toBeGreaterThan(0)
        expect(describeAttentionLevel(kind, level)).toBe(ATTENTION_LEVEL_COPY[kind][level])
      }
    }
    // The two kinds surface in different places, so their copy must not be interchangeable.
    expect(describeAttentionLevel('decisions', 'mute')).not.toBe(describeAttentionLevel('progress', 'mute'))
    expect(describeAttentionLevel('decisions', 'show')).toContain('Needs you')
    expect(describeAttentionLevel('progress', 'show')).toContain('feed')
    // Only `notify` promises an interruption; the quieter levels must say they do not.
    for (const kind of ATTENTION_KINDS) {
      expect(describeAttentionLevel(kind, 'notify')).toContain('push')
      expect(describeAttentionLevel(kind, 'show')).toContain('No inbox or push')
      expect(describeAttentionLevel(kind, 'mute')).toContain('Hidden')
    }
  })

  test('summarizeAttention collapses equal kinds and reports a mix as custom', () => {
    expect(summarizeAttention(WATCH_ATTENTION)).toBe('notify')
    expect(summarizeAttention(DEFAULT_ATTENTION)).toBe('show')
    expect(summarizeAttention({ decisions: 'mute', progress: 'mute' })).toBe('mute')
    expect(summarizeAttention({ decisions: 'notify', progress: 'mute' })).toBe('custom')
  })
})
