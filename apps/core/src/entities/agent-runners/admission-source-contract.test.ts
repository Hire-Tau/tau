import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUNNERS = [
  'artifact-builder-runner.ts',
  'concierge-runner.ts',
  'squad-manager-runner.ts',
  'squad-worker-runner.ts',
  'subagent-runner.ts',
  'system-manager-runner.ts',
]

describe('runner admission source contract', () => {
  test('base runner composes pre-session scope abort into lifecycle quiescence', () => {
    const source = readFileSync(join(import.meta.dir, 'base.ts'), 'utf8')
    expect(source).toContain('maintenanceLifecycle?.attachQuiesce(async () => {')
    expect(source).toContain('this.admissionScope?.abort(')
  })

  test.each(RUNNERS)('%s routes Pi construction through the admission helper', (file) => {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    expect(source).toContain('this.createPiSession(scope, async () =>')
    expect(source.indexOf('this.createPiSession(scope, async () =>')).toBeLessThan(
      source.indexOf('AgentSession.create(')
    )
  })

  test.each([
    ['artifact-builder-runner.ts', 'getShortTermMemory(this.agent.id)'],
    ['system-manager-runner.ts', 'SystemManagerRunner.buildManagerPrompt('],
  ])('%s performs unrelated session construction after sandbox setup', (file, unrelatedWork) => {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    const batch = source.indexOf('this.withSandboxSetupBatch(')
    expect(batch).toBeGreaterThan(-1)
    expect(source.indexOf(unrelatedWork, batch)).toBeGreaterThan(batch)
  })

  test.each(['concierge-runner.ts', 'squad-manager-runner.ts', 'squad-worker-runner.ts', 'subagent-runner.ts'])(
    '%s serializes squad ensure before light ensure',
    (file) => {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')
      const squadArg = file === 'subagent-runner.ts' ? 'resolvedSquad' : 'squad'
      const squad = source.indexOf(`await this.ensureSquadSandbox(${squadArg}, scope, this.sandboxSetupProgress)`)
      const light = source.indexOf('this.ensureLightSandbox({', squad)
      expect(squad).toBeGreaterThan(-1)
      expect(light).toBeGreaterThan(squad)
      expect(source.slice(squad, light)).not.toContain('Promise.all')
    }
  )
})
