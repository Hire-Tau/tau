import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { registerSkillCommands } from './skill'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'tau-skill-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerSkillCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

describe('skill CLI commands', () => {
  it('installs tau-memory to shared project skills for pi', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'tau-memory', '--agent', 'pi'])
    } finally {
      process.chdir(originalCwd)
    }

    const skill = await readFile(join(cwd, '.agents/skills/tau-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: tau-memory')
    expect(skill).toContain('## Installed Tau CLI')
    expect(skill).not.toContain('<tau-cli>')
    expect(skill).not.toContain('TAU_BIN')
    await expect(stat(join(cwd, '.agents/skills/tau-memory/install'))).rejects.toThrow()
  })

  it('installs tau-memory to claude project skills because claude does not use shared project skills', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'tau-memory', '--agent', 'claude-code'])
    } finally {
      process.chdir(originalCwd)
    }

    const skill = await readFile(join(cwd, '.claude/skills/tau-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: tau-memory')
  })

  it('installs tau-memory to a custom target directory', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'tau-memory', '--agent', 'custom', '--target-dir', targetDir])

    const skill = await readFile(join(targetDir, 'tau-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: tau-memory')
  })

  it('installs the tau operator skill from external/skills', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'tau', '--agent', 'custom', '--target-dir', targetDir])

    const skill = await readFile(join(targetDir, 'tau/SKILL.md'), 'utf8')
    expect(skill).toContain('name: tau\n')
    expect(skill).toContain('# Operating Tau (the `tau` CLI)')
    expect(skill).toContain('## Installed Tau CLI')
  })

  it('rejects skills that are not bundled', async () => {
    await expect(run(['skill', 'install', 'nope', '--agent', 'pi'])).rejects.toThrow(
      /unsupported skill: nope\. Supported skills: tau-memory, tau/
    )
  })

  it('requires a target directory for custom agents', async () => {
    await expect(run(['skill', 'install', 'tau-memory', '--agent', 'custom'])).rejects.toThrow(
      /custom agent requires --target-dir/
    )
  })

  it('refuses to overwrite an existing skill unless force is set', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'tau-memory', '--agent', 'codex'])
      await expect(run(['skill', 'install', 'tau-memory', '--agent', 'codex'])).rejects.toThrow(/already exists/)
      await run(['skill', 'install', 'tau-memory', '--agent', 'codex', '--force'])
    } finally {
      process.chdir(originalCwd)
    }
  })
})
