import { describe, test, expect } from 'bun:test'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { buildSharedWorkspaceHint, needsSharedWorkspaceHint, withSharedWorkspaceHint } from './private-bash-hint'

const WORKSPACE = '/home/box_e49af02f8b45/workspace'
const MEMORY = '/home/box_e49af02f8b45/memory'
const options = { sharedRoots: [WORKSPACE, MEMORY], workspaceMount: WORKSPACE }
const hint = buildSharedWorkspaceHint(WORKSPACE)

function fakeBash(behaviour: (command: string) => Promise<{ content: Array<{ type: 'text'; text: string }> }>) {
  return {
    name: 'bash',
    description: 'fake',
    parameters: {},
    execute: async (_id: string, params: { command: string }) => behaviour(params.command),
  } as unknown as AgentTool<any>
}

describe('needsSharedWorkspaceHint', () => {
  test('fires when a denied command names the shared workspace', () => {
    expect(
      needsSharedWorkspaceHint(
        {
          command: `cd ${WORKSPACE}/worktrees/x && ls`,
          output: `bash: cd: ${WORKSPACE}/worktrees/x: Permission denied`,
        },
        options
      )
    ).toBe(true)
  })

  test('fires when only the output names the shared memory dir', () => {
    expect(
      needsSharedWorkspaceHint(
        { command: 'cat "$M"/notes.md', output: `cat: ${MEMORY}/notes.md: Permission denied` },
        options
      )
    ).toBe(true)
  })

  test('stays quiet for a denial on an unrelated path', () => {
    expect(
      needsSharedWorkspaceHint({ command: 'cat /etc/shadow', output: 'cat: /etc/shadow: Permission denied' }, options)
    ).toBe(false)
  })

  test('stays quiet when the shared path is mentioned without a denial', () => {
    expect(needsSharedWorkspaceHint({ command: `echo ${WORKSPACE}`, output: WORKSPACE }, options)).toBe(false)
  })
})

describe('withSharedWorkspaceHint', () => {
  test('appends the hint to a thrown non-zero-exit error', async () => {
    const tool = withSharedWorkspaceHint(
      fakeBash(async () => {
        throw new Error(`bash: line 1: cd: ${WORKSPACE}/worktrees/x: Permission denied\nCommand exited with code 1`)
      }),
      options
    )
    await expect(
      tool.execute('c1', { command: `cd ${WORKSPACE}/worktrees/x && pwd` }, undefined as never)
    ).rejects.toThrow(hint)
  })

  test('appends the hint to a successful result that swallowed the denial', async () => {
    const tool = withSharedWorkspaceHint(
      fakeBash(async () => ({
        content: [
          {
            type: 'text',
            text: `ls: cannot access '${WORKSPACE}': Permission denied\n/home/box_1a34eed0897b/.private`,
          },
        ],
      })),
      options
    )
    const result = await tool.execute('c2', { command: `ls -la ${WORKSPACE} 2>&1 || true; pwd` }, undefined as never)
    const text = (result.content as Array<{ type: string; text: string }>).map((b) => b.text).join('\n')
    expect(text).toContain('Permission denied')
    expect(text.endsWith(hint)).toBe(true)
    expect(text.split(hint).length).toBe(2)
  })

  test('leaves unrelated failures and clean results untouched', async () => {
    const unrelated = withSharedWorkspaceHint(
      fakeBash(async () => {
        throw new Error('cat: /etc/shadow: Permission denied\nCommand exited with code 1')
      }),
      options
    )
    await expect(unrelated.execute('c3', { command: 'cat /etc/shadow' }, undefined as never)).rejects.toThrow(
      /^cat: \/etc\/shadow: Permission denied\nCommand exited with code 1$/
    )

    const clean = withSharedWorkspaceHint(
      fakeBash(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      options
    )
    const result = await clean.execute('c4', { command: 'echo ok' }, undefined as never)
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  test('rethrows non-Error rejections unchanged', async () => {
    const tool = withSharedWorkspaceHint(
      fakeBash(async () => {
        throw 'boom'
      }),
      options
    )
    await expect(tool.execute('c5', { command: `cd ${WORKSPACE}` }, undefined as never)).rejects.toBe('boom')
  })
})
