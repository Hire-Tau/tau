# Slack Canvas Source

`slack_canvas` is an indexed, searchable, readable, incremental, external source. Default sensitivity is `internal`.

Slack Canvas indexing is primarily used for huddle notes discovered from an indexed Slack thread. Slack exposes AI huddle notes as a Canvas file shared in the huddle thread.

## Source IDs

Canvas documents use `channelId:fileId` source IDs:

```text
C0123ABCDE:F0456
```

Channel scoping preserves provenance and avoids cross-channel access leaks when the same Canvas is shared in multiple places.

## Frontmatter

Each Canvas is one `memory_documents` row with frontmatter like:

```yaml
kind: slack_canvas
canvasKind: huddle_notes
channelId: C0123ABCDE
fileId: F0456
title: Huddle notes
sourceLinks:
  - https://acme.slack.com/docs/...
```

`canvasKind` is `huddle_notes` when Slack file metadata indicates huddle content; otherwise it is `canvas`.

## Chunk metadata

Canvas chunks include:

```json
{
  "sourceType": "slack_canvas",
  "parent": { "channelId": "C0123ABCDE", "fileId": "F0456" }
}
```

Canvas chunks are markdown chunks and do not currently add event metadata for individual sections.

## API and scopes

The adapter fetches content with Slack `files.info` and reads `file.canvas.document_content.markdown`.

Required bot access:

- `SLACK_BOT_TOKEN`
- Slack `files:read`
- bot access to the channel where the Canvas was shared

There is no public Slack huddle transcript endpoint. The indexed content is the Canvas markdown Slack exposes. If the Canvas is absent or not accessible, indexing skips and removes any stale document.

`canvases:read` is not required for this MVP. It would only be needed for a future section-level chunking implementation using `canvases.sections.lookup`.

## Policy and grants

`slack_canvas` reuses the configured `slack_thread` channel policy (`channelIds` and `excludeChannelIds`). If a Slack thread cannot be indexed from a channel, any Canvas referenced from that channel is also denied.

Grant filters support `channelIds` and compile to indexed search filters against `frontmatter.channelId`; malformed filters fail closed.

## Limitations

- Canvas indexing is normally fanned out from `slack_thread`; there is no broad Canvas discovery.
- Missing, inaccessible, or non-Canvas files are skipped and stale documents are removed.
- User identity is not enriched beyond Slack metadata present in the Canvas markdown.

Source class: [`SlackCanvasSource`](../../../../apps/core/src/services/memory/sources/SlackCanvasSource.ts).

Refreshed periodically by the external-source reindex runner (default 30 min) and via `POST /api/memory/:squadId/reindex` with the matching `source` value. See [Reindexing](../reindex.md).
