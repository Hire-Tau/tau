# Work-stream status presentation

Status is a read-only projection, not permission to advance, resume, approve, or merge work. Stored `done` alone means delivery is complete. A completed implementation (`completion-ready`) does **not** mean delivered.

## Shared contract

`WorkStream.delivery` is an optional, server-owned `WorkStreamDeliveryPresentation`. It is separate from the reserved metadata delivery-observation ledger. Clients must use `selectWorkStreamPresentationState`, not infer gates from metadata or PR existence.

| Delivery kind | Display/action label      | Semantic role | Human attention | Native bucket |
| ------------- | ------------------------- | ------------- | --------------- | ------------- |
| `approval`    | Approve Delivery          | review        | yes             | needsYou      |
| `review`      | Review Pull Request       | review        | yes             | needsYou      |
| `merge`       | Merge Pull Request        | review        | yes             | needsYou      |
| `external`    | Awaiting Code Host        | externalWait  | no              | externalWait  |
| `setup`       | Delivery Setup Required   | danger        | no              | blocked       |
| `failure`     | Delivery Changes Required | danger        | no              | blocked       |

Precedence: terminal stored status, explicit pause, explicit waits (review > question > dependency > manual), execution failure, recognized delivery fact, then ordinary execution/queue/idle derivation. The exact workflow-owned manual delivery-approval wait is identified by `approvalWaitId` and presented as approval; unrelated manual waits remain blockers. No wait is changed or synthesized by presentation.

An explicit `openWaits: []` still clears stale wait-derived states. Delivery is an independent positive fact, so it survives `[]`. Omitted waits retain older-server compatibility. Unknown future delivery kinds are ignored. Older clients may retain their historical rendering; the stored status and existing derived-state vocabulary remain unchanged.

Core loads flow, binding, policy and routed integration evidence in batch, without provider HTTP calls in serializers. Only activated completion-ready flows participate. Missing binding/routing or mismatched branches are setup problems. Unknown provider evidence and individual successful CI runs are external waits, not proof that required checks or reviews passed. PR events must match the configured provider/repository/number/connection and observed head. Late CI for another head cannot establish the current PR head. Current conflict, failing CI, closed PR and changes-requested evidence remain alarming. A positive aggregate GitHub `mergeable_state=clean` snapshot permits a merge label for human-merge policy; auto-merge policy stays external unless squad policy requires its documented human fallback. Additional designated delivery PRs participate too. Actual completion still uses the existing live provider verification and workflow guards.

### Asynchronous provider evidence

Designated PRs in activated, completion-ready delivery flows refresh a presentation-only snapshot through the existing leased, budgeted GitHub polling runner. These watches retain the runner's active polling cadence (60–120 seconds), including when verified webhooks suppress ordinary fallback watches. One bounded GraphQL query reads the current head, merge state, aggregate check rollup, required-review decision, and explicit reviewer types. `REVIEW_REQUIRED` identifies a review gate even when no reviewer has been requested. If aggregate access is unavailable, a fresh REST response is weaker evidence (a 304 never renews cached readiness); unknown review requirements are not guessed.

Snapshots are versioned in the existing polling cursor, scoped to squad/connection/repository/PR, and expire after five minutes. Serialization batch-reads this local cache alongside routed facts; it never calls GitHub. Baselines and same-head aggregate changes do not synthesize activity, inbox deliveries, waits, or flow transitions. A changed or cleared durable snapshot invalidates the existing status/attention/native-interest read models. Refreshing only its observation timestamp is silent.

Current-head evidence is reduced by provider observation order, not by event name: a full snapshot attached to a review can establish aggregate readiness, later successful individual CI does not erase that readiness, and a successful workflow cannot establish readiness by itself. New aggregate review/check facts supersede older negative evidence; later failures remain alarming, including on drafts. Review dismissal is reflected by the provider's refreshed aggregate decision without introducing a new routed review event. Unknown, stale, mismatched-head, or mismatched-scope observations cannot advertise a human merge gate.

## Native projection and version skew

`workBucket` deliberately aggregates human review, questions and manual blockers into amber `needsYou`. It preserves execution failures as `blocked`, uses neutral `paused`, and distinguishes orange `externalWait` from failures. Neither paused nor external work contributes to running or Needs you counts. Terminal rows are not part of Core's nonterminal interest query.

Widget summaries add an authoritative optional `bucket`, boolean `pause` (never private pause reasons), and typed `delivery`. Prefer `bucket` when present; older payloads can fall back to the shared selector. This also preserves the omitted-waits compatibility projection without fabricating waits. `openWaitTypes` remains an explicit array for existing native decoders. New `bucketCounts.paused` and `bucketCounts.externalWait` keys are optional in the consumer type, and should default to zero against older servers. Interest authorization, uncapped counts, title privacy and attention-first ordering remain unchanged. Foreground snapshots and APNs use the same builder.

Source compatibility was inspected at `Hire-Tau/tau-mobile` commit `c84b39e57de916a7acfeda2987e01c8d529c98e1`:

- Both copies of `TauWorkAttributes.swift` decode bucket as `String`, not a closed Codable enum.
- `WorkStreamsClient.swift` likewise decodes Live Activity buckets as strings and ignores additive summary/count fields.
- `StatusPalette.swift` maps unknown strings to neutral `.unknown`; an older Live Activity therefore shows neutral “Unknown” for the new buckets rather than rejecting its entire update.
- Older widget rows recompute their own buckets and cannot adopt the new semantics until updated; server totals remain authoritative. This is source verification, not a claim about every installed binary.

### Mobile adoption

Repack the shared package from the **independently reviewed, merged Core commit**, recording the actual source SHA and package checksum. Do not use an unreviewed branch archive. Update JS adapters plus both Swift attribute copies, native bucket/label/color mapping and widget summary decoding together. Map `paused` to neutral and `externalWait` to orange; retain amber Needs you. Preserve unknown-value fallback. Consume optional new count keys with zero defaults, and prefer the server's summary bucket. Run foreground/APNs parity, legacy-payload decoding and widget fixtures before release. This contract does not authorize a mobile release.

The matrix in `packages/shared/src/test-fixtures/work-stream-presentation.ts` is exercised through Core derivation/serialization, shared selection/attention/native projections, and visible web badges.
