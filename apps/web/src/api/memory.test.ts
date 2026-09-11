import { describe, expect, mock, test } from 'bun:test'
import { searchMemory } from './memory'
import { getSquadMemoryDownloadUrl, getSquadMemoryFile, getSquadMemoryTree } from './workspace'

const apiFetchCalls: Array<[string, RequestInit | undefined]> = []
const apiFetchMock = mock(async (path: string, init?: RequestInit) => {
  apiFetchCalls.push([path, init])
  return {} as never
})

describe('memory api', () => {
  test('getSquadMemoryTree builds encoded memory tree URL', async () => {
    apiFetchCalls.length = 0

    await getSquadMemoryTree('squad-1', '/memory/patterns', 1, apiFetchMock)

    expect(apiFetchCalls).toEqual([['/squads/squad-1/memory/tree?path=%2Fmemory%2Fpatterns&depth=1', undefined]])
  })

  test('getSquadMemoryFile builds encoded memory file URL', async () => {
    apiFetchCalls.length = 0

    await getSquadMemoryFile('squad-1', '/memory/context.md', apiFetchMock)

    expect(apiFetchCalls).toEqual([['/squads/squad-1/memory/file?path=%2Fmemory%2Fcontext.md', undefined]])
  })

  test('searchMemory builds provenance filter query params', async () => {
    apiFetchCalls.length = 0

    await searchMemory(
      'squad-1',
      {
        query: 'policy',
        sourceSquadIds: ['source-1', 'source-2'],
        sourceTypes: ['memory_file'],
        sensitivity: 'internal',
      },
      apiFetchMock
    )

    expect(apiFetchCalls).toEqual([
      [
        '/memory/squad-1/search?query=policy&sourceTypes=memory_file&sourceSquadIds=source-1%2Csource-2&sensitivity=internal',
        undefined,
      ],
    ])
  })

  test('getSquadMemoryDownloadUrl builds encoded memory download URL', () => {
    expect(getSquadMemoryDownloadUrl('squad-1', '/memory/context.md')).toBe(
      '/squads/squad-1/memory/download?path=%2Fmemory%2Fcontext.md'
    )
  })
})
