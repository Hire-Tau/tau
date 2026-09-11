import { describe, expect, it } from 'bun:test'
import { mergeSandboxStatus } from './status'

describe('mergeSandboxStatus', () => {
  it('preserves physical readiness without a declaration', () => {
    expect(mergeSandboxStatus({ status: 'running', devboxReady: true })).toEqual({
      status: 'running',
      devboxReady: true,
    })
  })

  for (const status of ['pending', 'installing', 'running_setup', 'failed'] as const) {
    it(`gates compatibility readiness while toolchain is ${status}`, () => {
      expect(
        mergeSandboxStatus({ status: 'running', devboxReady: true }, { status, desiredFingerprint: 'a'.repeat(64) })
          .devboxReady
      ).toBe(false)
    })
  }

  it('reports ready only when physical and managed environments are ready', () => {
    expect(
      mergeSandboxStatus(
        { status: 'running', devboxReady: true },
        { status: 'ready', desiredFingerprint: 'a'.repeat(64) }
      ).devboxReady
    ).toBe(true)
    expect(
      mergeSandboxStatus(
        { status: 'running', devboxReady: false },
        { status: 'ready', desiredFingerprint: 'a'.repeat(64) }
      ).devboxReady
    ).toBe(false)
  })
})
