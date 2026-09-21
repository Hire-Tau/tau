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
  streamed prefix; tool identity, args and result must match. Transport end while
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
exact status triggers a final replay/history refresh to recover missed text/tools;
a failed request is not interpreted as completion. The quiet backstop rearms on
same-status stream activity and verifies the exact execution when known, rather
than trusting a possibly stale agent-idle response. Legacy streams without exact
identity retain the existing idle fallback. Observed exact terminal status cannot
be undone by an older content-only replay.

After the bounded budget or a failed status read, the stream remains interrupted;
server-busy is not relabeled as success. Foreground/manual refresh and subsequent
execution updates remain recovery paths. This is not an indefinite background
poller or a guarantee of recovery while every transport/status request is offline.

## Authority boundary

The wire format has no message revision/event sequence discriminator. A shorter or
divergent saved fragment cannot prove an intentional edit to an **uncommitted**
streamed answer rather than stale/incomplete persistence. The client conservatively
retains that answer until coverage. Explicit authority for revising/removing such an
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
