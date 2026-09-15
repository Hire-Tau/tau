import { expect, test } from 'bun:test'
import { describeCodeHostReference, resolveCodeHostReference } from './code-hosting'

const binding = {
  integration: 'github',
  repository: 'Hire-Tau/tau-platform',
  changeRequest: { number: 1482, url: 'https://github.com/Hire-Tau/tau-platform/pull/1482' },
}

test('a well-formed binding resolves', () => {
  expect(resolveCodeHostReference({ codeHost: binding })).toEqual(binding)
  expect(describeCodeHostReference({ codeHost: binding })).toEqual({ status: 'valid', reference: binding })
})

test('extra keys on the change request are reported as invalid, never as an absent binding', () => {
  const annotated = {
    codeHost: {
      ...binding,
      changeRequest: { ...binding.changeRequest, state: 'MERGED', verifiedAt: '2026-09-15T20:53:18Z' },
    },
  }
  expect(resolveCodeHostReference(annotated)).toBeNull()
  const described = describeCodeHostReference(annotated)
  expect(described.status).toBe('invalid')
  expect(described.status === 'invalid' && described.issues).toEqual([
    'codeHost.changeRequest: unknown keys `state`, `verifiedAt` (allowed: number, url)',
  ])
})

test('missing required fields and bad values are described with their paths', () => {
  const described = describeCodeHostReference({ codeHost: { integration: 'GitHub', changeRequest: { number: 0 } } })
  expect(described.status).toBe('invalid')
  const issues = described.status === 'invalid' ? described.issues : []
  expect(issues.some((issue) => issue.startsWith('codeHost.integration:'))).toBe(true)
  expect(issues.some((issue) => issue.startsWith('codeHost.repository:'))).toBe(true)
  expect(issues.some((issue) => issue.startsWith('codeHost.changeRequest.number:'))).toBe(true)
})

test('metadata without any binding is absent, and the legacy github shape still resolves', () => {
  expect(describeCodeHostReference({})).toEqual({ status: 'absent' })
  expect(describeCodeHostReference(null)).toEqual({ status: 'absent' })
  expect(describeCodeHostReference({ delivery: {} })).toEqual({ status: 'absent' })
  expect(resolveCodeHostReference({ github: { repo: 'owner/repo', pr: { number: '7' } } })).toEqual({
    integration: 'github',
    repository: 'owner/repo',
    changeRequest: { number: 7 },
  })
})
