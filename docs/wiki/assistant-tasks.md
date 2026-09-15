# Assistant tasks and updates

Work delegated from a saved Assistant conversation keeps running after the browser closes, and what
the delegate reports back is stored so the user can catch up later. This page describes the tracked
task lifecycle, the reporting protocol agents use, and how unread and processed state behave.

## What a task is

A task is one delegated request within an Assistant conversation. It is a tracking record around an
inbox request chain: it is not a work stream, an execution, or another coordinator. The existing
delegate (the conversation's general User Assistant, its owned squad consultant, or an explicitly
targeted agent) owns execution and follow-through through existing agents, work streams, waits, and
integrations. Tracking adds presentation only; an update arriving never starts new execution.

- The task ID is the first outgoing inbox request ID; the current request advances when the user
  answers a question (`inReplyTo` on the answer).
- An independent request without `inReplyTo` is a new task, even when it reuses the same helper.
- The label comes from the delegation label, falling back to the request's first line (80 chars).

Statuses:

| Status        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `working`     | Accepted and in progress. Does not assert the agent is executing right now.      |
| `waiting`     | The delegate reports waiting on another agent, integration, or external event.  |
| `needs-input` | The delegate needs the user's answer before dependent work continues.            |
| `completed`   | The delegate explicitly reported the task complete.                              |
| `failed`      | The delegate explicitly reported it could not complete the task.                 |
| `cancelled`   | The delegate explicitly reported cancellation.                                   |
| `unknown`     | Historical task imported at upgrade time without lifecycle evidence.             |

Rules: an update without a status changes nothing; a report against a superseded request stays
visible but cannot change status; a terminal status is never reopened by a later `working`,
`waiting`, or `needs-input` report (a new user follow-up reopens it explicitly); idle or dormant
helpers never imply completion; a missing or terminated helper on an unfinished task is shown as
`unavailable` without rewriting its status.

## Reporting protocol

Delegates report through the inbox with a validated status flag:

```bash
tau inbox send assistant:CONVERSATION_UUID \
  "The comparison is finished. The recommended option is described below." \
  --recipient-type voice_assistant \
  --in-reply-to REQUEST_MESSAGE_UUID \
  --assistant-task-status completed
```

`--assistant-task-status` accepts `working`, `waiting`, `needs-input`, `completed`, `failed`, or
`cancelled`. It is accepted only from the agent that received the request, only for a local reply
to that saved Assistant mailbox, and is rejected (HTTP 400) for federated sends, other recipients,
and attempts to smuggle `assistantTaskStatus` or `assistantTaskId` through generic metadata. A
reply without the flag is still delivered and shown; it just leaves the tracked status unchanged.
The standing guidance lives in `config/agent-types/shared/assistant-task-reporting.md` and is
included by the User Assistant and consultant types.

## Processed versus seen

Two independent facts are stored for every update:

- `processed_at`: Realtime presented the update (or the user deliberately interrupted it).
  Processing requires a saved final Assistant entry whose `assistantUpdateIds` name the update,
  so a crash before the response was saved replays the update instead of losing it. Delivery is
  at-least-once presentation, not exactly-once audio.
- `seen_at`: the human acknowledged the update, either because its card intersected the visible
  scroll region in a visible document, or through “Mark updates read”, which acknowledges only the
  sequence that was displayed. Badges and previews never mark anything seen; audio playback alone
  does not either.

Catch-up batches feed at most 10 updates or 12,000 characters of model context per turn; the
stored message and the visible card are never truncated.

## Discovery and notifications

`GET /api/assistant/activity` returns owner-scoped totals plus the conversations with unread
updates or unfinished tasks, ordered by needs-input, then unread, then recency; `GET
/api/assistant/:id/activity` returns a conversation's tasks and its newest 50 updates with
pagination by sequence. Reads never lease a mailbox, create agents, or run models. The
`assistant.activityChanged` WebSocket event (identifiers only) is delivered to the conversation
owner alone, including on the collection topic. Push notifications go only to the owner and only
for status-changing `needs-input`, `completed`, and `failed` reports on the current request; routine
progress refreshes badges without a push. See [notifications](notifications.md).

## Upgrade behavior

Existing conversations are preserved. The migration reconstructs tasks from outgoing requests and
their `inReplyTo` chains (distinct roots stay distinct), imports incoming messages as updates in
`(created_at, id)` order, and marks every reconstructed task `unknown`. Previously read messages
become both processed and seen so the rollout does not resurrect old notifications; previously
unread ones stay unread. Historical read state cannot distinguish machine consumption from human
viewing — only updates created after the upgrade carry the precise processed/seen semantics.
