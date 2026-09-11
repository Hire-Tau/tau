import { describe, expect, test } from 'bun:test'
import { classifySandboxDeath } from './classifier'
import type { SandboxDeathObservation } from './types'

const base: SandboxDeathObservation = { sandboxId: 'squad_abc', signal: 'failed', runtime: 'k8s' }
const noIntent = () => null

describe('classifySandboxDeath', () => {
  test('Failed pod with no intent → unexpected', () => {
    expect(classifySandboxDeath(base, { consumeIntent: noIntent })).toBe('unexpected')
  })

  test('OOMKilled reason → oom', () => {
    expect(classifySandboxDeath({ ...base, reason: 'OOMKilled' }, { consumeIntent: noIntent })).toBe('oom')
  })

  test('exit code 137 → oom', () => {
    expect(classifySandboxDeath({ ...base, exitCode: 137 }, { consumeIntent: noIntent })).toBe('oom')
  })

  test('Evicted pod with memory pressure message → oom', () => {
    expect(
      classifySandboxDeath(
        { ...base, signal: 'evicted', reason: 'Evicted', message: 'The node was low on resource: memory.' },
        { consumeIntent: noIntent }
      )
    ).toBe('oom')
  })

  test('Evicted pod with MinimumFreeSpace reason → oom', () => {
    expect(
      classifySandboxDeath({ ...base, signal: 'evicted', reason: 'MinimumFreeSpace' }, { consumeIntent: noIntent })
    ).toBe('oom')
  })

  test('Evicted pod without memory pressure → unexpected', () => {
    expect(classifySandboxDeath({ ...base, signal: 'evicted', reason: 'NodeLost' }, { consumeIntent: noIntent })).toBe(
      'unexpected'
    )
  })

  test('idle-timeout intent → intentional', () => {
    expect(classifySandboxDeath(base, { consumeIntent: () => 'idle' })).toBe('intentional')
  })

  test('manual-stop intent → intentional', () => {
    expect(classifySandboxDeath(base, { consumeIntent: () => 'manual' })).toBe('intentional')
  })

  test('non-squad sandbox with no intent/OOM → ignored', () => {
    expect(classifySandboxDeath({ ...base, sandboxId: 'agent_x' }, { consumeIntent: noIntent })).toBe('ignored')
  })

  test('non-squad sandbox OOM → oom (cause detected before the non-squad short-circuit)', () => {
    // Solo `agent_<id>` OOMs must still be classified so the halt path keeps its
    // give-up backstop instead of treating every solo death as a benign recycle.
    expect(classifySandboxDeath({ ...base, sandboxId: 'agent_x', exitCode: 137 }, { consumeIntent: noIntent })).toBe(
      'oom'
    )
  })

  test('non-squad sandbox with manual-stop intent → intentional', () => {
    // A manually stopped solo agent reads as a deliberate stop, not 'ignored'.
    expect(classifySandboxDeath({ ...base, sandboxId: 'agent_x' }, { consumeIntent: () => 'manual' })).toBe(
      'intentional'
    )
  })
})
