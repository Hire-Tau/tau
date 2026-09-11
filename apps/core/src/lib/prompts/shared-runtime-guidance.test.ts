import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { buildWorkspacePrompt } from './workspace-prompt'

const repoRoot = join(import.meta.dir, '../../../../../')

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8')
}

describe('shared-first project command guidance', () => {
  test('does not retain the obsolete private-bash default in the runtime prompt source', async () => {
    const prompt = buildWorkspacePrompt({ squadId: 'squad', hasSquadBash: true })

    expect(prompt).toContain('Default to `squad_bash` for ALL repository and project commands')
    expect(prompt).not.toContain('default to it for your work')
    expect(prompt).not.toContain('ONLY when a process, port, dev server, or installed tool must be SHARED')
  })

  test('high-impact project workflow sources select squad_bash and avoid literal workspace roots', async () => {
    const paths = [
      'config/skills/frontend-visual-review/SKILL.md',
      'config/skills/deploy-app/SKILL.md',
      'config/skills/using-git-worktrees/SKILL.md',
      'config/skills/work-stream-driven-development/SKILL.md',
      'config/agent-types/sysops.yaml',
      'docs/wiki/agent-runners.md',
      'docs/wiki/consultant.md',
    ]

    for (const path of paths) {
      const source = await readRepoFile(path)
      expect(source, `${path} should select the shared command runtime`).toContain('squad_bash')
      expect(source, `${path} should not assume the container workspace mount`).not.toContain('/workspace/')
    }
  })
})
