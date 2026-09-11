import type { SessionEntry } from '@earendil-works/pi-coding-agent'

/** A compact, storage-cheap signature of the summarized prefix (entries up to
 * and including the cut point). Used to prove, across a session-reload boundary,
 * that a cached summary still describes the same prefix before it is applied. */
export interface PrefixFingerprint {
  /** Number of entries from the start up to and including the cut entry. */
  count: number
  /** FNV-1a hash of those ordered entry ids. */
  hash: string
}

function entryId(entry: SessionEntry): string | undefined {
  return (entry as { id?: string }).id
}

/** Fingerprint the prefix `[0..firstKeptEntryId]` (inclusive). Returns null if
 * the cut point is not present in `entries`. */
export function computePrefixFingerprint(entries: SessionEntry[], firstKeptEntryId: string): PrefixFingerprint | null {
  const cutIndex = entries.findIndex((entry) => entryId(entry) === firstKeptEntryId)
  if (cutIndex < 0) return null
  const count = cutIndex + 1

  let hash = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < count; i++) {
    const id = entryId(entries[i]) ?? ''
    for (let j = 0; j < id.length; j++) {
      hash ^= id.charCodeAt(j)
      hash = Math.imul(hash, 0x01000193)
    }
    // Separator byte so ['ab','c'] and ['a','bc'] hash differently.
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193)
  }

  return { count, hash: (hash >>> 0).toString(16) }
}

/** True iff `branchEntries` reproduces the fingerprinted prefix exactly — same
 * ids in the same order, ending at `firstKeptEntryId`. Any divergence (a changed
 * earlier entry, an inserted/removed entry, a moved cut, or an absent cut) → false. */
export function matchesPrefixFingerprint(
  branchEntries: SessionEntry[],
  fp: PrefixFingerprint,
  firstKeptEntryId: string
): boolean {
  const recomputed = computePrefixFingerprint(branchEntries, firstKeptEntryId)
  return recomputed != null && recomputed.count === fp.count && recomputed.hash === fp.hash
}
