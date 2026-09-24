/**
 * FNV-1a (32-bit), base36-encoded. Deterministic, non-cryptographic —
 * staleness/identity detection only (document-change hashing, build-time
 * content fingerprinting), never anything security-sensitive.
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5 // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
