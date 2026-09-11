export const MEMORY_SOURCE_TYPES = [
  'memory_file',
  'agent_thread',
  'workspace_file',
  'slack_thread',
  'slack_canvas',
  'github_issue',
  'linear_issue',
] as const

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number]

/**
 * Product kill switch for agent thread search. Agent threads are indexed from
 * execution lifecycle events, but are excluded from search surfaces until the
 * product decision changes. To re-enable, set this to true and update
 * MEMORY_SOURCE_TYPE_METADATA.agent_thread.searchableByDefault.
 */
export const AGENT_THREAD_SEARCH_ENABLED = false

export interface MemorySourceTypeMetadata {
  value: MemorySourceType
  label: string
  description: string
  searchableByDefault: boolean
}

export const MEMORY_SOURCE_TYPE_METADATA = [
  {
    value: 'memory_file',
    label: 'Memory files',
    description: 'Curated markdown documents in the squad memory vault.',
    searchableByDefault: true,
  },
  {
    value: 'agent_thread',
    label: 'Agent threads',
    description: 'Conversation history from agent work threads.',
    searchableByDefault: false,
  },
  {
    value: 'workspace_file',
    label: 'Workspace files',
    description: 'Indexed source and document files from squad workspaces.',
    searchableByDefault: true,
  },
  {
    value: 'slack_thread',
    label: 'Slack threads',
    description: 'Slack threads indexed from shared permalinks.',
    searchableByDefault: true,
  },
  {
    value: 'slack_canvas',
    label: 'Slack canvases',
    description: 'Slack Canvas and huddle notes indexed from referenced Slack threads.',
    searchableByDefault: true,
  },
  {
    value: 'github_issue',
    label: 'GitHub issues',
    description: 'GitHub issues and pull requests indexed from configured repositories.',
    searchableByDefault: true,
  },
  {
    value: 'linear_issue',
    label: 'Linear issues',
    description: 'Live Linear issue search results.',
    searchableByDefault: true,
  },
] as const satisfies readonly MemorySourceTypeMetadata[]

export const MEMORY_SOURCE_TYPE_LABELS: Record<MemorySourceType, string> = Object.fromEntries(
  MEMORY_SOURCE_TYPE_METADATA.map((sourceType) => [sourceType.value, sourceType.label])
) as Record<MemorySourceType, string>

export const DEFAULT_MEMORY_SEARCH_SOURCE_TYPES = MEMORY_SOURCE_TYPE_METADATA.filter(
  (sourceType) => sourceType.searchableByDefault
).map((sourceType) => sourceType.value) as MemorySourceType[]

export function isMemorySourceType(value: string): value is MemorySourceType {
  return (MEMORY_SOURCE_TYPES as readonly string[]).includes(value)
}
