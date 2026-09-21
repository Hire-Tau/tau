import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'

interface Job {
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const directory = new URL('./workflows/', import.meta.url)
const workflows = readdirSync(directory)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    workflow: Bun.YAML.parse(readFileSync(new URL(file, directory), 'utf8')) as Workflow,
  }))
const linuxRunner = 'ubuntu-24.04'

describe('external contribution boundaries', () => {
  for (const { file, workflow } of workflows) {
    if ('pull_request' in workflow.on) {
      test(`${file}: contributor jobs require no stored secrets or write permissions`, () => {
        expect(workflow.permissions).toEqual({ contents: 'read' })
        expect(JSON.stringify(workflow)).not.toMatch(/secrets\s*(?:\.|\[)/)
        expect(workflow.on).not.toHaveProperty('pull_request_target')
        for (const job of Object.values(workflow.jobs)) {
          expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' })
          expect(JSON.stringify(job)).not.toContain('softprops/action-gh-release')
          for (const step of job.steps ?? []) {
            if (step.uses?.startsWith('docker/build-push-action@')) expect(step.with?.push).not.toBe(true)
          }
        }
      })
    }
    test(`${file}: public repositories use GitHub-hosted runners`, () => {
      for (const job of Object.values(workflow.jobs)) {
        expect([linuxRunner, 'ubuntu-24.04', 'ubuntu-latest', 'macos-14']).toContain(job['runs-on'])
      }
    })
  }

  test('publishing workflows cannot be triggered by PRs or their completion', () => {
    for (const file of ['cli-binaries.yml', 'publish-images.yml']) {
      const workflow = workflows.find((entry) => entry.file === file)!.workflow
      expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
      expect(workflow.on.push).toEqual({ branches: ['main'], tags: ['v*'] })
    }
  })
})

describe('theme initiative and stack PR verification triggers', () => {
  const themePrBases = [
    'main',
    'initiative/color-themes',
    'work/d5bac5a5-1e6a-478d-a3b9-2d39d7c3a0d2',
    'work/5eeab375-9778-4300-98f3-42a7f10ce187',
    'work/7222b300-c1a1-4751-8da8-b43498711dfc',
    'work/9dac31b6-a6b5-4f51-83a7-1b75dac8ad3d',
    'work/94ffeaa8-42d3-4c06-b2d4-9abcb0768f43',
  ]

  for (const file of ['ci.yml', 'lint.yml']) {
    const workflow = workflows.find((entry) => entry.file === file)!.workflow
    test(`${file}: covers only main, initiative, and the exact reviewed theme-stack PR bases`, () => {
      expect(workflow.on.pull_request).toEqual({ branches: themePrBases })
      // This must not broaden push, publishing, or privileged target events.
      expect(workflow.on.push).toEqual({ branches: ['main'] })
      expect(workflow.on).not.toHaveProperty('pull_request_target')
      expect(workflow.permissions).toEqual({ contents: 'read' })
    })

    test(`${file}: checks the PR merge ref, not a pinned default/base branch`, () => {
      const jobIds = file === 'ci.yml' ? ['test-gates', 'test-typecheck', 'test-core', 'test-web'] : ['lint']
      for (const jobId of jobIds) {
        const checkout = workflow.jobs[jobId]!.steps!.find((step) => step.uses?.startsWith('actions/checkout@'))
        expect(checkout).toBeDefined()
        expect(checkout!.with?.ref).toBeUndefined()
      }
    })
  }

  test('CLA target event already covers every PR base without adding untrusted execution', () => {
    const cla = workflows.find((entry) => entry.file === 'cla.yml')!.workflow
    expect(cla.on.pull_request_target).toEqual({ types: ['opened', 'synchronize', 'reopened'] })
    expect(cla.on).not.toHaveProperty('pull_request')
  })
})
