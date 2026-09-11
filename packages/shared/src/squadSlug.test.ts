import { describe, expect, test } from 'bun:test'
import { slugify, squadSlugMap, type SlugSquadInput } from './squadSlug'

describe('slugify', () => {
  test('lowercases and hyphenates spaces', () => {
    expect(slugify('Acme Team')).toBe('acme-team')
  })
  test('strips symbols and emoji', () => {
    expect(slugify('Acme Team! 🚀')).toBe('acme-team')
  })
  test('collapses repeated separators', () => {
    expect(slugify('  Hello   World  ')).toBe('hello-world')
  })
  test('handles symbol runs mid-string', () => {
    expect(slugify('C++ Crew')).toBe('c-crew')
  })
  test('returns empty string when no alphanumerics', () => {
    expect(slugify('🚀🚀🚀')).toBe('')
    expect(slugify('   ')).toBe('')
  })
  test('keeps existing digits', () => {
    expect(slugify('Team 42')).toBe('team-42')
  })
})

const sq = (id: string, name: string, createdAt: string): SlugSquadInput => ({ id, name, createdAt })

describe('squadSlugMap', () => {
  test('maps unique names directly', () => {
    const { idToSlug, slugToId } = squadSlugMap([sq('a', 'Acme Team', '2026-01-01T00:00:00Z')])
    expect(idToSlug['a']).toBe('acme-team')
    expect(slugToId['acme-team']).toBe('a')
  })

  test('suffixes collisions by createdAt then id order', () => {
    const { idToSlug } = squadSlugMap([
      sq('b', 'Acme Team', '2026-01-02T00:00:00Z'),
      sq('a', 'Acme Team', '2026-01-01T00:00:00Z'),
      sq('c', 'Acme Team', '2026-01-03T00:00:00Z'),
    ])
    // Oldest (a) keeps the bare slug; later ones get -2, -3.
    expect(idToSlug['a']).toBe('acme-team')
    expect(idToSlug['b']).toBe('acme-team-2')
    expect(idToSlug['c']).toBe('acme-team-3')
  })

  test('ordering is independent of input order', () => {
    const inOrder = squadSlugMap([sq('a', 'X', '2026-01-01T00:00:00Z'), sq('b', 'X', '2026-01-02T00:00:00Z')])
    const reversed = squadSlugMap([sq('b', 'X', '2026-01-02T00:00:00Z'), sq('a', 'X', '2026-01-01T00:00:00Z')])
    expect(inOrder.idToSlug).toEqual(reversed.idToSlug)
  })

  test('falls back to id when name has no slug', () => {
    const { idToSlug, slugToId } = squadSlugMap([sq('uuid-123', '🚀', '2026-01-01T00:00:00Z')])
    expect(idToSlug['uuid-123']).toBe('uuid-123')
    expect(slugToId['uuid-123']).toBe('uuid-123')
  })

  test('round-trips id -> slug -> id', () => {
    const squads = [
      sq('a', 'Acme Team', '2026-01-01T00:00:00Z'),
      sq('b', 'Acme Team', '2026-01-02T00:00:00Z'),
      sq('c', 'Other', '2026-01-03T00:00:00Z'),
    ]
    const { idToSlug, slugToId } = squadSlugMap(squads)
    for (const s of squads) {
      expect(slugToId[idToSlug[s.id]]).toBe(s.id)
    }
  })
})
