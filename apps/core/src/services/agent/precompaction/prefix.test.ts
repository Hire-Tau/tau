import { describe, it, expect } from 'bun:test'
import { computePrefixFingerprint, matchesPrefixFingerprint } from './prefix'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

const e = (id: string): SessionEntry => ({ id, type: 'message' }) as unknown as SessionEntry

describe('prefix fingerprint', () => {
  it('returns null when the cut point is not in the entries', () => {
    expect(computePrefixFingerprint([e('a'), e('b')], 'missing')).toBeNull()
  })

  it('matches an identical prefix (cut inclusive)', () => {
    const snap = [e('a'), e('b'), e('keep'), e('x')]
    const fp = computePrefixFingerprint(snap, 'keep')!
    expect(fp.count).toBe(3) // a, b, keep
    // Later branch appended more entries after the cut — prefix unchanged.
    expect(matchesPrefixFingerprint([e('a'), e('b'), e('keep'), e('x'), e('y')], fp, 'keep')).toBe(true)
  })

  it('rejects a divergent prefix that still contains the cut id', () => {
    const fp = computePrefixFingerprint([e('a'), e('b'), e('keep')], 'keep')!
    // Same cut id present, but an entry before it differs (b -> b2).
    expect(matchesPrefixFingerprint([e('a'), e('b2'), e('keep')], fp, 'keep')).toBe(false)
  })

  it('rejects when the cut moved to a different position', () => {
    const fp = computePrefixFingerprint([e('a'), e('b'), e('keep')], 'keep')!
    expect(matchesPrefixFingerprint([e('a'), e('keep')], fp, 'keep')).toBe(false)
  })

  it('rejects when the cut id is absent from the later branch', () => {
    const fp = computePrefixFingerprint([e('a'), e('keep')], 'keep')!
    expect(matchesPrefixFingerprint([e('a'), e('b')], fp, 'keep')).toBe(false)
  })
})
