/**
 * Memory Services
 *
 * Squad memory system for persistent, searchable knowledge storage.
 */

// =============================================================================
// Services
// =============================================================================

export * from './indexer'

export { MaintenanceService } from './MaintenanceService'
export type {
  MaintenanceOptions,
  MaintenanceReport,
  BrokenLink,
  StaleDocument,
  NormalizationResult,
} from './MaintenanceService'

export { SearchService } from './SearchService'
export type { SearchOptions, SearchResult, SearchServiceDeps } from './SearchService'

export { WriteService } from './WriteService'
export type { MemoryWriteResult, MemoryReadResult } from './WriteService'

export { ListService } from './ListService'
export type { MemoryListEntry, MemoryListResult } from './ListService'

// =============================================================================
// Paths & Utilities
// =============================================================================

export {
  // Path functions
  getSquadMemoryBasePath,
  getSquadMemoryPath,
  ensureSquadMemoryPath,
  readSquadMemoryFile,
  toFilesystemPath,
  toMemoryPath,
  validateMemoryPath,
  // Error handling
  MemoryErrorCodes,
  MemoryWriteError,
} from './paths'
export type { MemoryErrorCode, MemoryError } from './paths'

// =============================================================================
// Parser
// =============================================================================

export { parseFrontmatter, parseWikilinks, chunkMarkdown, computeContentHash } from './parser'
export type { ParsedFrontmatter, WikiLink, ContentChunk, ChunkOptions } from './parser'

// =============================================================================
// Thread Indexer
// =============================================================================

export { indexAgentThreads, indexAgentThread, isAgentIndexed, removeAgentThread } from './thread-indexer'
export type { ThreadIndexStats } from './thread-indexer'

export { registerThreadIndexerEvents, isThreadIndexerEventsRegistered } from './thread-indexer-events'

// =============================================================================
// Sub-modules
// =============================================================================

export * from './sources'
export * from './sync'
