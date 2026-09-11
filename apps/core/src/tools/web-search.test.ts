import { describe, test, expect } from 'bun:test'
import { createWebTools, createWebSearchTool } from './web-search'

describe('web-tools adapter', () => {
  test('createWebTools returns globally installed pi webfetch and websearch tools with keys', async () => {
    const tools = await createWebTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(['webfetch', 'websearch'])
    expect(tools.map((tool) => tool.key).sort()).toEqual(['webfetch', 'websearch'])
  })

  test('createWebSearchTool returns the global pi websearch tool for backward compatibility', async () => {
    const tool = await createWebSearchTool()

    expect(tool.name).toBe('websearch')
    expect(tool.key).toBe('websearch')
    expect(tool.description).toContain('Exa AI')
  })
})
