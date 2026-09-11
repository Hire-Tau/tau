# Memory System

The memory system gives squads persistent, searchable knowledge. Content is chunked, embedded, and stored in Postgres with pgvector for semantic search.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              MemorySourceAdapter implementations          │
│                                                          │
│  FileSource        ThreadSource      WorkspaceFileSource │
│  SlackThreadSource GitHubIssueSource SlackCanvasSource   │
│  LinearLiveSource  (queried live at search time)         │
│                                                          │
│  Indexed lifecycle: list → fetch → normalize → upsert    │
└──────────┬──────────────┬──────────────────┬─────────────┘
           │              │                  │
           ▼              ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│                   IndexingService                         │
│                                                          │
│  Registers indexed and live adapters; delegates indexing │
│  and exposes adapter metadata for search/grant validation│
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                IndexedDocumentWriter                      │
│                                                          │
│  1. Normalize title, sensitivity, frontmatter, provenance│
│  2. Parse content and wikilinks; chunk by source shape   │
│  3. Hash chunks for change detection (SHA256)            │
│  4. Preserve unchanged chunks (skip re-embedding)        │
│  5. Embed changed chunks (OpenAI text-embedding-3-small) │
│  6. Store documents/chunks/links in Postgres             │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                      Database                             │
│                                                          │
│  memoryDocuments — one per source item                   │
│  memoryChunks    — text chunks with vector embeddings    │
│  memoryLinks     — wikilink references between docs      │
│  squadSourceConfigs — per-squad ingestion policies       │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    SearchService                          │
│                                                          │
│  Hybrid indexed search + parallel live adapter fan-out   │
│  with grant scope validation and fail-closed filtering   │
└──────────────────────────────────────────────────────────┘
```

## Key Concepts

### Chunk Preservation

Every chunk gets a SHA256 content hash. When a document is re-indexed, existing chunk hashes are compared to new ones. Unchanged chunks keep their existing embeddings — only changed/new chunks are sent to OpenAI. This makes re-indexing fast and cheap.

### Sources

All content enters through a **source adapter** — an implementation of the `MemorySourceAdapter` lifecycle. Adapters discover and fetch source content; `IndexedDocumentWriter` normalizes and upserts documents, chunks, links, sensitivity, and provenance metadata. See [Adapter Lifecycle](adapter-lifecycle.md) for adapter contracts and provenance conventions.

Source docs:

- [Memory Files](memory-files.md) — Markdown files in the squad's memory directory
- [Agent Threads](agent-threads.md) — Agent conversation history
- [Workspace Files](workspace-files.md) — Files from the squad's sandbox workspace
- [Slack Threads](sources/slack-thread.md) — Slack thread ingestion by permalink
- [Slack Canvas](sources/slack-canvas.md) — Slack Canvas and huddle notes discovered from threads
- [GitHub Issues and PRs](sources/github-issue.md) — GitHub issue/PR bodies and comments
- [Linear Issues](sources/linear-issue.md) — Live Linear issue search

Capability matrix:

| Source type      | Kind    | Capabilities                                          | Default sensitivity |
| ---------------- | ------- | ----------------------------------------------------- | ------------------- |
| `memory_file`    | indexed | searchable, readable, writable, incremental, external | `internal`          |
| `agent_thread`   | indexed | searchable, readable, incremental                     | `internal`          |
| `workspace_file` | indexed | searchable, readable, external                        | `internal`          |
| `slack_thread`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `slack_canvas`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `github_issue`   | indexed | searchable, readable, incremental, external           | `internal`          |
| `linear_issue`   | live    | searchable, live, external                            | `internal`          |

### Search

The `SearchService` supports three modes:

- **hybrid** (default) — Combines vector similarity and keyword matching with weighted scoring, then applies MMR for diversity
- **vector** — Pure semantic search via pgvector cosine distance
- **keyword** — Multi-term ILIKE matching

Filters: `sourceTypes`, `kinds` (frontmatter), `tags` (frontmatter), `paths` (glob patterns).

### Sync

Memory files can be synced to external storage via providers:

- **Git** — Clone/pull/push to a Git repo (SSH or HTTPS)
- **S3** — Sync to an S3 bucket (or S3-compatible like MinIO)

See [Sync](sync.md) for details.

## Schema

### `memoryDocuments`

| Column      | Type      | Description                                        |
| ----------- | --------- | -------------------------------------------------- |
| id          | uuid      | Primary key                                        |
| squadId     | uuid      | FK → squads                                        |
| sourceType  | text      | `memory_file`, `agent_thread`, or `workspace_file` |
| sourceId    | text      | File path or agent ID                              |
| title       | text      | Extracted from frontmatter or first heading        |
| path        | text      | File path (nullable)                               |
| frontmatter | jsonb     | YAML frontmatter or metadata                       |
| contentHash | text      | SHA256 of full content                             |
| updatedAt   | timestamp | Last indexed                                       |
| createdAt   | timestamp | First indexed                                      |

Unique constraint: `(squadId, sourceType, sourceId)`

### `memoryChunks`

| Column      | Type         | Description                           |
| ----------- | ------------ | ------------------------------------- |
| id          | uuid         | Primary key                           |
| squadId     | uuid         | FK → squads                           |
| documentId  | uuid         | FK → memoryDocuments (cascade delete) |
| chunkIndex  | integer      | Position in document                  |
| startLine   | integer      | Start line in source                  |
| endLine     | integer      | End line in source                    |
| content     | text         | Chunk text                            |
| contentHash | text         | SHA256 for change detection           |
| embedding   | vector(1536) | pgvector embedding (nullable)         |
| metadata    | jsonb        | Heading, agent info, etc.             |
| createdAt   | timestamp    | Created                               |

IVFFlat index on `embedding` for fast cosine similarity search.

### `memoryLinks`

| Column           | Type | Description                                |
| ---------------- | ---- | ------------------------------------------ |
| id               | uuid | Primary key                                |
| squadId          | uuid | FK → squads                                |
| sourceDocumentId | uuid | FK → memoryDocuments (cascade delete)      |
| targetRaw        | text | Original wikilink text `[[Page#Heading]]`  |
| targetDocumentId | uuid | Resolved FK (nullable, set null on delete) |
| targetHeading    | text | Heading within target (nullable)           |

## Configuration

Memory is configured per-squad in `squads.metadata.memory`:

```typescript
interface SquadMemoryConfig {
  enabled: boolean
  embeddingModel?: string // default: 'text-embedding-3-small'
  workspacePaths?: {
    include: string[] // glob patterns relative to /workspace
    exclude?: string[] // additional excludes (merged with defaults)
  }
  sync?: {
    providers?: Array<GitSyncProvider | S3SyncProvider>
    conflictPolicy?: 'manual' | 'last_write_wins'
    pushDebounceSeconds?: number
    pullIntervalMinutes?: number
  }
}
```

## Key Files

| File                                                                    | Description                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/core/src/services/memory/indexer/IndexingService.ts`              | Main orchestrator — registers sources, delegates indexing |
| `apps/core/src/services/memory/indexer/EmbeddingService.ts`             | OpenAI embedding generation                               |
| `apps/core/src/services/memory/indexer/ReindexScheduler.ts`             | Debounced reindex queue (60s default)                     |
| `apps/core/src/services/memory/indexer/ExternalSourceReindexService.ts` | Manual external-source reindex orchestration              |
| `apps/core/src/services/memory/indexer/ExternalSourceReindexRunner.ts`  | Periodic external-source reindex runner (30 min default)  |
| `apps/core/src/services/memory/parser.ts`                               | Frontmatter, wikilinks, chunking                          |
| `apps/core/src/services/memory/SearchService.ts`                        | Hybrid vector/keyword search with MMR                     |
| `apps/core/src/services/memory/MaintenanceService.ts`                   | Broken links, stale docs, normalization                   |
| `apps/core/src/services/memory/sources/`                                | Source implementations                                    |
| `apps/core/src/services/memory/sync/`                                   | Git and S3 sync adapters                                  |
| `apps/core/src/services/memory/thread-indexer.ts`                       | Agent thread indexing                                     |
| `packages/k8s-sandbox/src/services/watcher.ts`                          | Sandbox file watcher                                      |
