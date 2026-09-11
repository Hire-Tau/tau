// Re-export delegate to the engine's default fetchPeerAgentKey implementation
// (docs/history/superpowers/specs/2026-07-08-amtp-engine-design.md §7.4/§5.8). KEPT
// (not deleted) — the frozen route-level suite dynamic-imports this module in
// afterEach seam resets (routes/amtp.inbox.test.ts, routes/amtp.receive-signed.test.ts).
// The engine's signature already matches this module's original one exactly,
// so the delegate is a straight re-export with no logic of its own.
export { defaultFetchPeerAgentKey as fetchPeerAgentKey } from 'amtp-engine'
export type { PeerAgentKey } from 'amtp-engine'
