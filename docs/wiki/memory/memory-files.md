# Memory Files

Source type: `memory_file`

Capabilities: searchable, readable, writable, incremental, external

Memory files are Markdown documents stored in a squad's memory directory (`<data-dir>/memory/<squadId>/`). They're the primary way to give squads persistent knowledge — decisions, patterns, reference material, etc.

## How It Works

1. Files are written to the memory directory (manually, by agents, or via sync)
2. `FileSource` scans the directory recursively for `.md` files
3. Each file is parsed: frontmatter extracted, wikilinks resolved, content chunked by headings
4. Chunks are hashed and compared to existing — only changed chunks get re-embedded
5. Wikilinks are resolved to existing documents and stored in `memoryLinks`

## Parsing Pipeline

### Frontmatter

Standard YAML frontmatter between `---` fences:

```markdown
---
title: Authentication Design
kind: decision
tags: [auth, security]
importance: high
---

# Authentication Design

...
```

Supported frontmatter fields:

- `title` — Document title (falls back to first `# Heading`)
- `kind` — Document type (e.g., `decision`, `pattern`, `reference`)
- `tags` — Array of tags for filtering
- `importance` — `low`, `medium`, `high`, `critical` (affects search ranking)

### Wikilinks

Standard `[[Target]]` or `[[Target#Heading]]` or `[[Target|Alias]]` syntax. Links inside code blocks are ignored.

Resolved against existing documents in the same squad by matching the target to document titles or paths.

### Chunking

Markdown content is chunked by headings:

1. Split on `# Heading` boundaries
2. If a section exceeds 2000 chars, split by paragraphs
3. If a paragraph exceeds 2000 chars, split by sentences/words
4. Each chunk preserves its heading context in metadata

Defaults: `maxChunkSize=2000`, `minChunkSize=100`, `overlapSize=100`.

## Indexing

### Automatic

The `ReindexScheduler` triggers re-indexing when files change. It uses a debounced queue (60s default) — multiple rapid changes are batched into a single reindex pass.

### Manual

Reindex can be triggered via the API:

```
POST /api/memory/:squadId/reindex
```

Or the `memory reindex` tool in agent conversations.

## File Lifecycle

- **Created/Modified**: Content is parsed, chunked, and embedded. Unchanged chunks preserve existing embeddings.
- **Deleted**: The corresponding document and all its chunks are removed from the database.
- **Renamed**: Treated as delete + create (new document, new embeddings).

## Maintenance

The `MaintenanceService` runs hourly and handles:

- **Broken links**: Wikilinks pointing to deleted/renamed documents
- **Stale documents**: Files not updated in 30+ days (informational)
- **Normalization**: Adds missing `id` and `updatedAt` fields to frontmatter

## Implementation

- Source: `apps/core/src/services/memory/sources/FileSource.ts`
- Parser: `apps/core/src/services/memory/parser.ts`
- Scheduler: `apps/core/src/services/memory/indexer/ReindexScheduler.ts`
- Maintenance: `apps/core/src/services/memory/MaintenanceService.ts`
