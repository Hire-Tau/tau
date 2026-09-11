import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workflow = readFileSync(join(import.meta.dir, 'workflows/ci.yml'), 'utf8')

describe('setup helper CI gate', () => {
  test('runs the complete setup shell suite on Linux with real yq coverage', () => {
    const start = workflow.indexOf('- name: Run setup helper suite')
    expect(start).toBeGreaterThan(-1)
    const nextStep = workflow.indexOf('\n      - name:', start + 1)
    const step = workflow.slice(start, nextStep === -1 ? undefined : nextStep)
    expect(step).toContain('ensure_yq')
    expect(step).toContain('bash scripts/setup/lib.test.sh')
    // The summary line is gated, not just the exit code: a `set -e` abort
    // mid-suite exits without printing "N passed, 0 failed", and an exit-code
    // mask must not be able to turn that green.
    expect(step).toContain('passed, 0 failed')
    expect(step).not.toContain('continue-on-error')
    expect(step).not.toContain('if:')
  })

  test('runs the setup shell suite AS ROOT so the root-install assertions execute, gated on its summary line', () => {
    const start = workflow.indexOf('- name: Run setup helper suite (root install)')
    expect(start).toBeGreaterThan(-1)
    const nextStep = workflow.indexOf('\n      - name:', start + 1)
    const step = workflow.slice(start, nextStep === -1 ? undefined : nextStep)
    expect(step).toContain('sudo env "PATH=$PATH" bash scripts/setup/lib.test.sh')
    expect(step).toContain('passed, 0 failed') // summary-line gate
    // The root step must ALSO positively prove the root-install sections
    // executed (see the marker test below) — a green summary alone cannot
    // tell "executed" from "self-skipped again under sudo".
    expect(step).toContain('TAU root-install sections: ENABLED')
    expect(step).not.toContain('continue-on-error')
    expect(step).not.toContain('if:')
  })
})

describe('lib.test.sh root-install marker', () => {
  const libTest = readFileSync(join(import.meta.dir, '../scripts/setup/lib.test.sh'), 'utf8')

  // The root CI step greps for this exact token; lib.test.sh must emit it
  // ONLY when the capability probe passed, or the gate proves nothing. If
  // either side drifts, this test fails before CI ever lies.
  test('emits the exact token the root gate greps, inside the probe-success branch only', () => {
    const marker = "echo 'TAU root-install sections: ENABLED'"
    expect(libTest).toContain(marker)
    expect(libTest.split(marker).length - 1).toBe(1) // exactly once
    // Structurally inside the probe's success branch: after the success
    // assignment, before the failure assignment.
    const probeIf = libTest.indexOf('TAU_TEST_ROOT_INSTALL=1')
    const probeElse = libTest.indexOf('TAU_TEST_ROOT_INSTALL=0')
    expect(probeIf).toBeGreaterThan(-1)
    expect(probeElse).toBeGreaterThan(probeIf)
    const markerAt = libTest.indexOf(marker)
    expect(markerAt).toBeGreaterThan(probeIf)
    expect(markerAt).toBeLessThan(probeElse)
    // And the unprivileged run must stay quiet: the marker echo sits before
    // the summary line (tail -n 1 gates are unaffected by construction).
    const summaryAt = libTest.indexOf('passed, %d failed')
    expect(summaryAt).toBeGreaterThan(markerAt)
  })
})
