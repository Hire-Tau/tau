# Work references

Each Tau instance assigns an immutable, increasing number to every work stream, across all squads. Use `#42` in conversations and labels and `42` in CLI/API lookups and URLs (`/squads/<squad>/work?ws=42`). Moving work does not change its number. Numbers are never reused; gaps are normal. Existing work is numbered by creation time, with UUID order breaking ties.

UUIDs remain internal keys and are still returned as `id`; API objects additionally return `number`. UUIDs and unique UUID prefixes remain accepted for lookup. Digits-only references prefer a work number; use a longer UUID prefix or full UUID when a numeric prefix collides. `#42` explicitly requests a numeric lookup (quote it in the shell and URL-encode the hash as `%23` in API paths). Ambiguous UUID prefixes fail rather than picking a stream. References are local to the instance, not globally unique across servers.

Examples: `tau workstream get 42`, `tau workstream get '#42'`, and `GET /api/workstreams/42`. Existing UUID links remain valid. Agent chats can use `[#42](tau:ws:42)`; bare work numbers in prose are also linked, while code and explicit PR/issue references are preserved.

## Tracked issues and pull requests

A work stream can track any number of GitHub issues and pull requests alongside
the one PR that gates its delivery. The canonical set is computed, not stored as
one field — it is the union of:

1. **The delivery PR** — `metadata.codeHost.changeRequest` (or the legacy
   `metadata.github.repo`/`metadata.github.pr.number`/`.url` equivalent). This is
   the only resource whose merge/completion evidence can finish a `pr-merge` or
   `pr-auto-merge` work stream.
2. **The legacy issue** — `metadata.github.repo` + `metadata.github.issue`, kept
   for backward compatibility.
3. **`metadata.tracked[]`** — an array of explicit entries, the canonical way to
   attach additional resources.

Resolution walks the list in that order and de-duplicates by
`integration:repository:kind:number` (case-insensitive on the repository), so the
same PR referenced as both the delivery binding and a `tracked[]` entry appears
once, tagged with its first (highest-priority) source.

### `metadata.tracked[]` entry shape

```json
{
  "integration": "github",
  "repository": "owner/repo",
  "kind": "issue",
  "number": 12,
  "connectionId": "0f1e2d3c-...",
  "url": "https://github.com/owner/repo/issues/12",
  "addedAt": "2026-01-01T00:00:00.000Z",
  "origin": {
    "eventId": "b2b7...",
    "resourceKey": "owner/repo#12",
    "output": "issue.assigned",
    "occurredAt": "2026-01-01T00:00:00.000Z"
  }
}
```

`integration`, `repository`, `kind` (`issue` or `pull_request`), and `number` are
required identity fields; `connectionId` and `url` are optional. `addedAt` is
stamped server-side when absent. `origin` records the integration event that
produced the entry (when there was one) and is **server-managed**: a client
cannot set or forge it — writing an `origin` that doesn't match the event actually
being resolved is rejected with `400`.

Never hand-write `github.*`/`codeHost` metadata, or a raw `tracked[]` entry, to
attach a resource. Use the CLI/API paths below; they resolve identity, check
authorization, and stamp `origin` atomically.

### Adding and removing tracked resources

```bash
tau workstream create "<title>" --squad <squad-id> --from-event <event-id>   # new stream, idempotent
tau workstream track <ws-id> --event <event-id>                             # attach to an existing stream
tau workstream track <ws-id> --issue owner/repo#12
tau workstream track <ws-id> --pr owner/repo#34
tau workstream track <ws-id> --url https://github.com/owner/repo/pull/34
tau workstream untrack <ws-id> --issue owner/repo#12
tau workstream tracked <ws-id>   # alias: links
```

API surface:

- `POST /api/workstreams` accepts `integrationEventId` (a UUID). It resolves the
  event's issue/PR, stores the link with `origin`, and replays of the same event
  return `200 { ...stream, reusedFromEvent: true }` instead of creating a
  duplicate stream.
- `GET /api/workstreams/:id/tracked` returns
  `{ resources: [...{ integration, repository, kind, number, key, source, url?, subscriptionIds, subscribed }], subscriptions }`.
- `POST /api/workstreams/:id/tracked` accepts exactly one of `{ "event": "<uuid>" }`,
  `{ "url": "<resource url>" }`, or `{ "resource": { integration, repository, kind, number, connectionId? } }`.
- `DELETE /api/workstreams/:id/tracked` accepts `{ "url": ... }` or `{ "resource": ... }`.
  Untracking the delivery PR is rejected with `409 { code: "delivery_change_request" }`
  — edit `metadata.codeHost.changeRequest` instead.
- Writing `metadata.tracked` directly through `PATCH`/`set-meta` is schema-validated
  shape-for-shape, and any newly introduced entry is authorized exactly like an
  explicit track request.

All of these require `workstreams:update` on the work stream's squad.

### Authorization: identity is not access

A URL or an integration event only supplies **identity** — which issue/PR is
meant. **Access** always comes from the squad's own integration connection:

- An event is only usable if it was observed under a connection this squad
  owns; an event belonging to another squad, or one observed at instance-wide
  (non-squad) authority, is rejected with `403`. An unknown event ID is `404`.
- A URL or explicit `{ integration, repository, kind, number }` reference is
  checked against the squad's assigned, authorized connection for that
  integration; a squad with no authorized GitHub connection gets `403`.

This means the same GitHub issue can be tracked by two different squads, each
authorized through its own connection, without either granting the other access.

### Subscription IDs and completion semantics

Turning on **Code hosting** (`completion.followChanges: true`) derives a
subscription set for every resource in the canonical tracked set, each
targeting `delivery-owner` by default:

| Source            | ID prefix (reserved)            |
| ----------------- | ------------------------------- |
| Delivery PR       | `code-host-<event>`             |
| Legacy issue      | `code-host-issue-<event>`       |
| `tracked[]` entry | `tracked-<12-hex-hash>-<event>` |

The hash in a `tracked-` ID is derived from the resource's identity
(`integration:repository:kind:number`), so adding or removing one tracked link
never renumbers another's subscriptions.

Only the delivery PR's merge/completion evidence can finish a `pr-merge` or
`pr-auto-merge` work stream. Activity on any other tracked resource — a tracked
PR's reviews or CI, a tracked issue closing, reopening, or being relabeled — is
informational: it never finishes the stream, clears an open manual/review wait,
bypasses admission or a pause, or discards acceptance requirements.

### Diagnosing "why isn't this delivering"

`GET /api/workstreams/:id/tracked` (and `tau workstream tracked`) reports a
top-level `subscriptions` status alongside each resource:

| Status          | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `active`        | The stream has a running flow with Code hosting on; subscriptions are live |
| `no-flow`       | The stream has no attached workflow run — attach one                       |
| `not-following` | The attached flow does not have `completion.followChanges` set             |
| `ended`         | The stream is done/canceled; nothing is delivered anymore                  |

Even when `subscriptions` is `active`, an individual resource's `subscribed`
flag can still be `false` if nothing matches it yet. `GET /api/workflows/runs/:streamId`
→ `integrationDeliveries` reports the actual delivery outcome per subscription,
including a reason when one was skipped or superseded: `Work stream ended`,
`Subscription changed`, `Resource binding changed`, `Connection no longer
available`, `Work stream parked; owner notified`, `Recipient blocked by an
unrelated wait`, or `Waiting for consumer activation`.

### Known limits

- Activity records one row per `(event, squad)`; if more than one work stream in
  a squad could match the same event, only the first is associated.
- Repository visibility for a URL-based link is enforced when events actually
  arrive for it, not at the moment it is linked.
- Poll/webhook de-duplication relies on GitHub's second-precision timestamps;
  two independent changes inside the same second can collapse.
- Linear issues/links are not covered by tracked resources.
