import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { promptIncludes } from '../../db'
import { PromptInclude } from '../../entities/PromptInclude'
import { AGENT_TYPE_INCLUDES_DIR } from '../../lib/paths'
import { assertConfigId, assertNonEmptyString } from '../../lib/validation/config-ids'
import { ConfigSync } from './ConfigSync'

export interface PromptIncludeMarkdown {
  id: string
  name: string
  description?: string
  content: string
}

/** Name = first markdown heading (any level) or the id; description = first non-heading paragraph line. */
export function parsePromptIncludeMarkdown(content: string, id: string): PromptIncludeMarkdown {
  assertConfigId(id, 'prompt include id')
  assertNonEmptyString(content, 'content')
  const lines = content.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line))
  const name = headingIndex >= 0 ? lines[headingIndex].replace(/^#{1,6}\s+/, '').trim() : id
  const description = lines
    .slice(headingIndex >= 0 ? headingIndex + 1 : 0)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
  return { id, name, ...(description ? { description } : {}), content }
}

/** Reads every include block on disk, keyed by file stem. Shared with AgentTypeSync validation. */
export async function loadIncludeFiles(dir: string = AGENT_TYPE_INCLUDES_DIR): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const file of entries) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue
    out.set(file.replace(/\.md$/, ''), await readFile(join(dir, file), 'utf-8'))
  }
  return out
}

export class PromptIncludeSync extends ConfigSync<PromptIncludeMarkdown> {
  readonly name = 'prompt-includes'
  readonly directory = AGENT_TYPE_INCLUDES_DIR
  readonly table = promptIncludes
  readonly idColumn = promptIncludes.id
  readonly yamlTemplateColumn = promptIncludes.yamlTemplate
  readonly yamlFieldOverridesColumn = promptIncludes.yamlFieldOverrides
  readonly updatedAtColumn = promptIncludes.updatedAt
  readonly disabledColumn = promptIncludes.disabled

  async loadFromDir(): Promise<PromptIncludeMarkdown[]> {
    const files = await loadIncludeFiles(this.directory)
    if (files.size === 0) this.log.warn(`Directory empty or missing: ${this.directory}`)
    return [...files.entries()].map(([id, content]) => parsePromptIncludeMarkdown(content, id))
  }

  parse(content: string, filename: string): PromptIncludeMarkdown {
    return parsePromptIncludeMarkdown(content, filename.replace(/\.md$/i, ''))
  }

  toRecord(parsed: PromptIncludeMarkdown): Record<string, unknown> {
    return { id: parsed.id, name: parsed.name, description: parsed.description ?? null, content: parsed.content }
  }

  getId(parsed: PromptIncludeMarkdown): string {
    return parsed.id
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return { id: row.id, name: row.name, description: row.description ?? null, content: row.content }
  }

  toYaml(row: Record<string, unknown>): string {
    return String(row.content ?? '')
  }

  async afterSync(): Promise<void> {
    PromptInclude.invalidateCache()
  }
}
