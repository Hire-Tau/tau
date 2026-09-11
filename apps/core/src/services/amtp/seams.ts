// Leaf module for the engine's high-level network-op overrides (§7.1/§7.4).
// Kept separate from both routes/amtp.ts and engine.ts so neither forms an
// ESM import cycle (routes/amtp.ts → services/amtp/engine.ts →
// routes/amtp.ts would otherwise result if the seams lived in either). Task 6
// re-exports `__setPullImpl`/`__setKeyFetchImpl` from routes/amtp.ts so the
// frozen route-level tests' imports from './amtp' keep working unchanged.
//
// Defaults are the two kept delegate modules, which themselves delegate to
// the engine-exported default implementations (createDefaultAttachmentPull /
// defaultFetchPeerAgentKey) — single-engine is preserved.
import { pullAttachment } from './attachment-pull'
import { fetchPeerAgentKey } from './peer-key-fetch'

/** Module-level pull seam — overridable in tests via __setPullImpl. */
export let pullImpl: typeof pullAttachment = pullAttachment

/** Test-only: replace the pull implementation. Reset in afterEach to avoid cross-test leakage. */
export function __setPullImpl(fn: typeof pullAttachment): void {
  pullImpl = fn
}

/** Module-level key-fetch seam — overridable in tests via __setKeyFetchImpl. */
export let keyFetchImpl: typeof fetchPeerAgentKey = fetchPeerAgentKey

/** Test-only: replace the peer key-fetch implementation. Reset in afterEach. */
export function __setKeyFetchImpl(fn: typeof fetchPeerAgentKey): void {
  keyFetchImpl = fn
}
