import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { CONFIG_DIR } from '../../lib/paths'

const skillPath = join(CONFIG_DIR, 'skills', 'amtp', 'SKILL.md')

function skillsOf(file: string): string[] {
  const doc = parse(readFileSync(join(CONFIG_DIR, 'agent-types', file), 'utf-8')) as { skills?: string[] }
  return doc.skills ?? []
}

describe('amtp skill', () => {
  test('SKILL.md has the amtp frontmatter and the trust caveat', () => {
    const md = readFileSync(skillPath, 'utf-8')
    expect(md).toContain('name: amtp')
    // The honest caveat MUST be present so agents do not over-trust agentSigVerified.
    expect(md).toContain('agentSigVerified')
    expect(md.toLowerCase()).toContain('not a trusted human')
  })

  test('is attached to the manager and concierge agent types (not engineer/worker)', () => {
    expect(skillsOf('manager.yaml')).toContain('amtp')
    expect(skillsOf('concierge.yaml')).toContain('amtp')
    expect(skillsOf('engineer.yaml')).not.toContain('amtp')
  })
})
