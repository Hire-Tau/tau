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
