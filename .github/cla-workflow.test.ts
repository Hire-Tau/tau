import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { CLA_ACTION_COMMIT, prepareClaAction } from './prepare-cla-action'

const workflow = parse(readFileSync(new URL('./workflows/cla.yml', import.meta.url), 'utf8'))
const config = parse(readFileSync(new URL('./cla.yml', import.meta.url), 'utf8'))

describe('CLA credentials and trusted execution', () => {
  test('never checks out contributor code with the registry credential', () => {
    const checkouts = workflow.jobs.cla.steps.filter((step: any) => step.uses?.startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(2)
    expect(checkouts[0].with.ref).toBe('${{ github.event.pull_request.base.sha || github.sha }}')
    expect(checkouts[1].with.ref).toBe(CLA_ACTION_COMMIT)
    expect(checkouts[1].with.repository).toBe('overtrue/cla-bot')
    for (const step of checkouts) expect(step.with['persist-credentials']).toBe(false)
    expect(workflow.on).toEqual({
      pull_request_target: { types: ['opened', 'synchronize', 'reopened'] },
      issue_comment: { types: ['created', 'edited'] },
    })
  })
  test('keeps the registry address in protected configuration', () => {
    expect(config.registry.repository).toBe('configured/registry')
    expect(workflow.jobs.cla.env.CLA_REGISTRY_REPOSITORY).toBe('${{ secrets.CLA_REGISTRY_REPOSITORY }}')
    const token = workflow.jobs.cla.steps.find((step: any) => step.id === 'registry-token')
    expect(token.with.repositories).toBe('${{ secrets.CLA_REGISTRY_REPOSITORY }}')
    expect(token.with.owner).toBe('${{ github.repository_owner }}')
    expect(token.with['permission-contents']).toBe('write')
  })
  test('preserves the existing agreement and contributor requirements', () => {
    expect(config.document.version).toBe('v1')
    expect(config.signing.comment_pattern).toBe('I have read the CLA Document and I hereby sign the CLA')
    expect(config.contributors.check_pr_author).toBe(true)
    expect(config.contributors.check_commit_authors).toBe(true)
    expect(config.status.check_name).toBe('CLA Check')
    expect(workflow.jobs.cla.name).not.toBe('CLA Check')
  })
  test('fails closed on missing configuration or unreviewed action code', () => {
    expect(() => prepareClaAction('malicious action', '', '')).toThrow('configuration')
    expect(() => prepareClaAction('malicious action', 'example', 'agreements')).toThrow('reviewed version')
    expect(() => prepareClaAction('malicious action', 'example', '../agreements')).toThrow('configuration')
  })
})
