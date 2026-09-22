# Live conversation reconciliation

Web and mobile share the client-core group store/combine layer and client-react
conversation hook. Reconnect must not replace a visible answer with an earlier
saved fragment.

## Invariants

- Catchup routes lifecycle events in an isolated replay store. A leading historical
  `flush_agent`, unscoped `done`, or `error` cannot target the live cursor. A genuine
  mid-turn flush still targets its replay predecessor.
- Uncommitted groups retain identity, start time, local content and observed terminal
  flags across incomplete replay. A superset replay fills disconnect gaps without
  appending duplicate deltas. An absent lifecycle event is not a reversal.
- Done, flushed, errored and transport-ended handoffs all require durable ordered
  block coverage and every announced done message ID. Saved text may extend the
  streamed prefix. Tool identity must match. An explicitly unfinished tool permits
  saved argument extensions. Replacement of a differing provisional result additionally
  requires identified execution completion and collection rows whose reads began **after**
  that confirmation. Terminal status, an invalidation in progress, an old cached row,
  or a pre-confirmation read finishing late is not that authority. Generation counters
  also carry ephemeral runtime ownership and a shared monotonic clock: remounting does not
  restart it, concurrent views can share fresh reads, and dehydrated pages cannot
  claim current runtime freshness. Point-read overlays
  do not inherit collection freshness: the qualifying collection must own every row
  of the turn. A finalized (or legacy) tool still requires exact args/result/error equality. Every other
  observed block and done message ID must also be covered. Transport end while
  the execution is still busy cannot retire an otherwise open group.
- After durable handoff, only the group ID is retired until conversation reset.
  Historical replay cannot resurrect it after an authoritative history revision or
  deletion. No response text is retained in that retirement set. Persisted-only
  updates, collection/point-read ordering and confirmed queue clears retain their
  existing authority rules.
- Cancellation owns the SSE reader as well as fetch abort. Dispatch checks the
  signal after reads/yields and during fallback catchup iteration. Hook callbacks
  additionally check subscription generation and conversation identity. First-create
  adoption preserves its handoff, but late create callbacks cannot adopt again.

## Bounded recovery

Foreground still reconnects and invalidates conversation queries. An unexpectedly
ended exact running/queued/stopping execution gets at most two additional exact
status reconciliations/reconnections per mounted conversation. The transport's
existing 15 retries remain unchanged. Parked sandbox/maintenance transports keep
using the existing resume signal rather than spinning reconnects.

Reconciliation is fenced by subscription and execution identity/version. A terminal
exact status triggers a post-confirmation history refresh to recover missed
text/tools: the terminal exact stream sends only an execution snapshot and EOF,
**not worker catchup**. Busy reconnects can still receive catchup. A failed request
is not interpreted as completion. The quiet backstop rearms on every subscription
replacement (even a silent one) and on same-status stream activity. It verifies the
exact execution when known, rather than trusting a possibly stale agent-idle response. Legacy streams without exact
identity retain the existing idle fallback. Observed exact terminal status cannot
be undone by an older content-only replay.

The proxy and runner share the same in-band `error` event shape. An error is not
proof of execution failure. For an identified execution, the hook keeps the exact
pin and last known status, reports a reconnecting transport, and does not latch a
terminal group/error status. Same-execution content/catchup can recover normally;
exhausted EOF enters the existing bounded exact-status/history reconciliation.
Verified terminal snapshots/status responses remain protected against stale replay.
No decision depends on English error messages. Legacy errors without execution
identity retain their failed fallback; distinguishing their source requires a future
wire error-category contract. A failed exact read remains interrupted, never success.

After the bounded budget or a failed status read, the stream remains interrupted;
server-busy is not relabeled as success. Foreground/manual refresh and subsequent
execution updates remain recovery paths. This is not an indefinite background
poller or a guarantee of recovery while every transport/status request is offline.

### Open-but-silent transport and deferred manual intent

An open SSE connection with stale cached busy status now gets **three** automatic
exact-execution probes per query-client/agent/execution while at least one view is
mounted. They start after **15 seconds quiet**, then no sooner than **30** and
**60 seconds** after the preceding probe (15/45/105 seconds without activity).
Activity uses `performance.now()`, not server timestamps or wall-clock changes.
A shared monotonic event ordinal also fences cached exact results: a response
started before resumed activity cannot later terminalize that activity, even when
several events share one clock tick.
Activity and subscription replacement postpone deadlines but **never replenish**
the budget. Changing execution/conversation or removing the last observer releases
that scope; a later fresh mount gets a fresh budget. Parked sandbox/maintenance,
legacy unidentified streams and non-live transports do not start silent probes.
The existing EOF/terminal-query recovery paths remain separate.

Each probe makes one exact GET, with a **10-second abort deadline**, and on success
one conversation invalidation batch (history, agent detail, active execution).
History cost is the number of loaded infinite-query pages, not necessarily one HTTP
request. Query retry policy still applies to history/detail/active reads; the exact
probe itself does not retry. The redundant exact infinite-history invalidation was
removed: the existing messages prefix already includes that query. This avoids
canceling/restarting the same history batch. No general query cleanup is included.
Concurrent views share the exact read, budget, terminal-history watermark and one
invalidation batch; later cached observers can consume the same result. Releasing
the last observer aborts its pending exact request. Network failure, timeout, or
budget exhaustion preserves busy status and local text/tools: silence is **not**
completion. Automatic probes neither replace SSE nor stop server work and expose no
new loading/refresh UI state. Only verified exact terminal status allows an ended
handoff, still subject to the existing ordered coverage and fresh-history rules.

An early manual press is coalesced and drains after **4 seconds quiet** without
needing done/error or another click. Activity postpones the drain, but at **30 seconds
from the first press** the intent runs a read-only reconciliation even during
continued activity; it does not reconnect an actively emitting stream. Quiet manual
refresh still replaces the subscription, preserving its existing catchup semantics
and local buffers. Manual exact reads share pending requests and a four-second
coalescing window, and do not refill the automatic budget. A failed exact read still
allows explicit history refresh, never a fabricated terminal state. An online-manager
offline signal suppresses new probes/drains, retains explicit intent, and rearms on
online notification. A pending exact read times out; late results cannot mutate a
replacement subscription/execution/conversation. Foreground refresh satisfies an
already deferred manual request instead of scheduling a second quiet refresh.
Synchronous foreground notifications to several mounted views share one invalidation
batch; each view still owns its own SSE replacement. Terminal-confirmation reads are
not folded into that batch, preserving their post-confirmation authority.
Unmount/agent switch cancels intent. Connectivity and provider availability are not
guaranteed by these timers; after exhaustion, foreground/manual or a new execution
remain recovery paths. This source behavior does not establish an installed iOS
incident's cause, and does not change mobile feedback/release policy.

Regression coverage uses owned timers plus mounted hook/query tests, including a
real agents resource/SSE parser with open readers and two simultaneous views:

| Case                                          | Expected result                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Silent open SSE, stale busy cache, newer HTTP | Exact terminal/history recovery without remount or SSE replacement; no intermediate lost prefix |
| Quiet running execution                       | Busy/content retained; three probes then no loop                                                |
| Early/repeated manual press                   | One quiet drain; activity postponed, 30s starvation bound                                       |
| Offline / pending / failure                   | No offline polling; 10s abort; honest busy; explicit later recovery                             |
| Provisional tools                             | Visible progress survives every render until post-confirmation saved coverage                   |
| Multiple views                                | One exact read/history batch, shared causal watermark, no replay duplication                    |
| Identity switch / unmount                     | Late result ignored; last-view request aborted; no new-chat mutation                            |
| Foreground/manual overlap                     | Foreground consumes prior intent, no second quiet refresh                                       |

## Authority boundary

The wire format has no message revision/event sequence discriminator. A shorter or
divergent saved fragment cannot prove an intentional edit to an **uncommitted**
streamed answer rather than stale/incomplete persistence. The client conservatively
retains that answer until coverage. Differing unfinished-tool results have one narrow
causal authority: an identified execution's exact terminal confirmation (or runner `done` with
saved row IDs, emitted after persistence), followed by a new server history read. This relies on terminal execution status following durable tool
persistence; it does not label arbitrary matching tool rows as completed. Without
execution identity or such a completed read, provisional results retain strict
result/error coverage. No field is added to the wire protocol. Explicit authority for revising/removing such an
uncommitted response would require a wire contract; this change does not invent one.
Once handed off, saved history remains authoritative, including deletion/revision.
Retired IDs and per-execution status/recovery metadata last only for the mounted
conversation and are cleared on identity reset; they contain no response content.

## Verification and adoption

Focused tests run from their package directory with its config, **not repository
root** (root preloads Core's DB harness):

```sh
cd packages/client-react
bun test --config ./bunfig.toml ../client-core/src/conversation ../client-core/src/resources/agents.test.ts ../client-core/src/sse.test.ts src
bunx --no-install tsc --noEmit -p tsconfig.json
# In a separate shell from repository root:
cd apps/web
bun test --config ./bunfig.toml src/components/AgentChat.test.tsx
```

These cover source state-machine behavior and mounted web integration; they do not
verify native FlatList/RAF rendering or identify the cause on an installed device.
No mobile source, tarball, native build, deployment or release is changed here.

Adopt only the independently reviewed **merged full Core SHA**, recorded in delivery
evidence. Revalidate the supported commands on the current mobile base:

```sh
bun run core:update -- <full-40-character-merged-Core-SHA> [--source /path/to/core]
bun run dependencies:check
```

The updater packs shared/client-core/client-react from the exact source checkout and
records source/archive/lock integrity. Never edit packed tarballs or roll back other
accepted shared contracts. Device verification still needs OS/device, app version
and numeric build, bundled Core provenance, and affected execution/group IDs. Any
trace should use IDs, event types, counts, lifecycle/coverage decisions and lengths,
not response text, tokens or credentials. Native release authorization is separate.
