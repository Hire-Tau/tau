import { describe, expect, it } from 'bun:test'
import { FileSource } from './FileSource'
import { ThreadSource } from './ThreadSource'
import { WorkspaceFileSource } from './WorkspaceFileSource'
import type { MemorySourceAdapter, SourceCapability } from './adapter'

const adapters: MemorySourceAdapter[] = [FileSource.instance(), ThreadSource.instance(), WorkspaceFileSource.instance()]

describe('MemorySourceAdapter contract', () => {
  for (const adapter of adapters) {
    it(`${adapter.sourceType} declares capabilities`, () => {
      expect(adapter.capabilities.all.size).toBeGreaterThan(0)
      for (const capability of adapter.capabilities.all) {
        expect(adapter.capabilities.has(capability)).toBe(true)
      }
    })

    it(`${adapter.sourceType} declares default sensitivity`, () => {
      expect(['public', 'internal', 'restricted', 'confidential']).toContain(adapter.defaultSensitivity)
    })

    it(`${adapter.sourceType} implements lifecycle methods`, () => {
      expect(typeof adapter.list).toBe('function')
      expect(typeof adapter.fetch).toBe('function')
      expect(typeof adapter.index).toBe('function')
      expect(typeof adapter.indexAll).toBe('function')
      expect(typeof adapter.exists).toBe('function')
      expect(typeof adapter.remove).toBe('function')
      expect(typeof adapter.reconcile).toBe('function')
    })
  }

  it('declares source-specific capability sets', () => {
    const expected = new Map<string, SourceCapability[]>([
      ['file', ['searchable', 'readable', 'writable', 'incremental', 'external']],
      ['agent_thread', ['searchable', 'readable', 'incremental']],
      ['workspace_file', ['searchable', 'readable', 'external']],
    ])

    for (const adapter of adapters) {
      const capabilities = expected.get(adapter.sourceType) ?? []
      expect([...adapter.capabilities.all].sort()).toEqual([...capabilities].sort())
    }
  })
})
