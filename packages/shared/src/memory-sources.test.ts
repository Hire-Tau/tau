import { describe, expect, it } from 'bun:test'
import {
  AGENT_THREAD_SEARCH_ENABLED,
  DEFAULT_MEMORY_SEARCH_SOURCE_TYPES,
  MEMORY_SOURCE_TYPE_LABELS,
  MEMORY_SOURCE_TYPE_METADATA,
  MEMORY_SOURCE_TYPES,
  isMemorySourceType,
} from './memory-sources'

describe('memory source metadata', () => {
  it('defines metadata for every known source type', () => {
    expect(MEMORY_SOURCE_TYPE_METADATA.map((sourceType) => sourceType.value)).toEqual([...MEMORY_SOURCE_TYPES])
    expect(MEMORY_SOURCE_TYPE_LABELS.slack_thread).toBe('Slack threads')
    expect(MEMORY_SOURCE_TYPE_LABELS.slack_canvas).toBe('Slack canvases')
    expect(MEMORY_SOURCE_TYPE_LABELS.github_issue).toBe('GitHub issues')
    expect(MEMORY_SOURCE_TYPE_LABELS.linear_issue).toBe('Linear issues')
  })

  it('derives default memory search sources from metadata', () => {
    expect(DEFAULT_MEMORY_SEARCH_SOURCE_TYPES).toEqual([
      'memory_file',
      'workspace_file',
      'slack_thread',
      'slack_canvas',
      'github_issue',
      'linear_issue',
    ])
    expect(DEFAULT_MEMORY_SEARCH_SOURCE_TYPES).not.toContain('agent_thread')
  })

  it('exposes the agent_thread search kill switch', () => {
    expect(AGENT_THREAD_SEARCH_ENABLED).toBe(false)
  })

  it('checks source type membership', () => {
    expect(isMemorySourceType('slack_canvas')).toBe(true)
    expect(isMemorySourceType('linear_issue')).toBe(true)
    expect(isMemorySourceType('unknown_source')).toBe(false)
  })
})
