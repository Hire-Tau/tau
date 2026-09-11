import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  amtpConformancePhases,
  buildAmtpConformanceEntrypoint,
  runFileCapturedProcess,
  stripAmtpConformancePhases,
} from './node-conformance-process'
import {
  assertExactWhoamiPhases,
  isCompleteWhoamiJson,
  runAuditedWhoami,
  type WhoamiCustodySnapshot,
} from './node-conformance-whoami'

const NODE_ENTRY = Bun.resolveSync('amtp-node', import.meta.dir)
const EXPECTED_WHOAMI_SUCCESS_PHASES = [
  'process:start',
  'sqlite-open:start',
  'sqlite-open:done',
  'identity-read:start',
  'identity-read:done',
  'registrations-read:start',
  'registrations-read:done',
  'response-write:start',
  'response-write:done',
  'sqlite-close:start',
  'sqlite-close:done',
] as const

let ownedDirectories: string[] = []

afterEach(async () => {
  await Promise.all(ownedDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
  ownedDirectories = []
})

async function ownedDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  ownedDirectories.push(directory)
  return directory
}

describe('audited whoami contract', () => {
  const valid = JSON.stringify({
    instanceId: 'instance',
    registrations: [
      {
        handle: 'cardless',
        address: 'amtp://instance/cardless',
        inboundOpen: false,
        agentPublicKeyPem: 'key',
      },
    ],
  })

  test('accepts one complete whoami document containing exactly one target', () => {
    expect(isCompleteWhoamiJson(valid, 'cardless')).toBe(true)
  })

  test.each([
    '',
    '{',
    '{}',
    `${valid}\n${valid}`,
    JSON.stringify({
      instanceId: 'instance',
      registrations: [JSON.parse(valid).registrations[0], JSON.parse(valid).registrations[0]],
    }),
    JSON.stringify({ instanceId: 'instance', registrations: [] }),
  ])('rejects incomplete or ambiguous terminal output', (stdout) => {
    expect(isCompleteWhoamiJson(stdout, 'cardless')).toBe(false)
  })

  test('requires the complete ordered phase sequence', () => {
    const phases = [
      { operation: 'entrypoint', phase: 'module-loaded' },
      ...EXPECTED_WHOAMI_SUCCESS_PHASES.map((phase) => ({ operation: 'whoami', phase })),
    ]
    expect(() => assertExactWhoamiPhases(phases)).not.toThrow()
    expect(() => assertExactWhoamiPhases(phases.slice(0, -1))).toThrow('whoami-custody:phase-order')
    expect(() => assertExactWhoamiPhases([phases[1]!, phases[0]!, ...phases.slice(2)])).toThrow(
      'whoami-custody:phase-order'
    )
  })

  test('uses one absolute deadline while ignoring concurrent sibling files', async () => {
    const calls: Array<[string, number]> = []
    const siblingFiles: string[] = []
    let now = 1_000
    const snapshot: WhoamiCustodySnapshot = {
      readSet: {
        identity: { instanceId: 'instance', publicKeyPem: 'instance-key' },
        registrations: [{ handle: 'cardless', inboundOpen: 0, agentPublicKeyPem: 'key', cardJson: null }],
      },
      operationFiles: [],
      service: {
        pid: 1,
        port: 1234,
        instanceId: 'instance',
        publicKeyPem: 'instance-key',
        exitCode: null,
        signalCode: null,
      },
      entrypoint: { sourcePath: 'source', path: 'bundle', sha256: 'a'.repeat(64) },
    }
    const dependencies: Parameters<typeof runAuditedWhoami>[1] = {
      now: () => now,
      operationId: () => '11111111-1111-4111-8111-111111111111',
      sleep: async (ms) => {
        calls.push(['sleep', ms])
        now += ms
      },
      snapshotBefore: async ({ remainingMs }) => {
        calls.push(['before', remainingMs])
        now += 250
        return snapshot
      },
      run: async ({ timeoutMs }: { timeoutMs: number }) => {
        calls.push(['run', timeoutMs])
        siblingFiles.push('concurrent-sibling.tmp')
        now += 250
        return {
          command: ['bun', 'bundle', '--json', 'whoami'],
          capturePaths: ['stdout', 'stderr'],
          pid: 2,
          exitCode: 0,
          signalCode: null,
          stdout: valid,
          stderr: '',
          conformancePhases: [
            { operation: 'entrypoint', phase: 'module-loaded' },
            ...EXPECTED_WHOAMI_SUCCESS_PHASES.map((phase) => ({ operation: 'whoami', phase })),
          ],
        }
      },
      assertCapturePathsGone: async (_paths, { remainingMs }) => {
        calls.push(['captures-gone', remainingMs])
        now += 250
      },
      snapshotAfter: async ({ remainingMs }) => {
        calls.push(['after', remainingMs])
        now += 250
        return snapshot
      },
      assertServiceReady: async ({ remainingMs }) => {
        calls.push(['service-ready', remainingMs])
        now += 250
      },
    }
    await runAuditedWhoami({ handle: 'cardless', timeoutMs: 20_000 }, dependencies)
    expect(calls).toEqual([
      ['before', 20_000],
      ['sleep', 100],
      ['before', 19_650],
      ['run', 19_400],
      ['captures-gone', 19_150],
      ['after', 18_900],
      ['service-ready', 18_650],
    ])
    expect(now).toBe(2_600)
    expect(siblingFiles).toEqual(['concurrent-sibling.tmp'])
  })

  test('rejects an exact owned capture leak', async () => {
    const snapshot: WhoamiCustodySnapshot = {
      readSet: {
        identity: { instanceId: 'instance', publicKeyPem: 'instance-key' },
        registrations: [{ handle: 'cardless', inboundOpen: 0, agentPublicKeyPem: 'key', cardJson: null }],
      },
      operationFiles: [],
      service: {
        pid: 1,
        port: 1234,
        instanceId: 'instance',
        publicKeyPem: 'instance-key',
        exitCode: null,
        signalCode: null,
      },
      entrypoint: { sourcePath: 'source', path: 'bundle', sha256: 'a'.repeat(64) },
    }
    await expect(
      runAuditedWhoami(
        { handle: 'cardless', timeoutMs: 20_000 },
        {
          now: () => 1_000,
          operationId: () => '11111111-1111-4111-8111-111111111111',
          sleep: async () => {},
          snapshotBefore: async () => snapshot,
          run: async () => ({
            command: ['bun', 'bundle', '--json', 'whoami'],
            capturePaths: ['owned.stdout', 'owned.stderr'],
            pid: 2,
            exitCode: 0,
            signalCode: null,
            stdout: valid,
            stderr: '',
            conformancePhases: [
              { operation: 'entrypoint', phase: 'module-loaded' },
              ...EXPECTED_WHOAMI_SUCCESS_PHASES.map((phase) => ({ operation: 'whoami', phase })),
            ],
          }),
          assertCapturePathsGone: async () => {
            throw new Error('whoami-custody:captures')
          },
          snapshotAfter: async () => snapshot,
          assertServiceReady: async () => {},
        }
      )
    ).rejects.toThrow('whoami-custody:captures')
  })
})

function custodySnapshot(registrations: WhoamiCustodySnapshot['readSet']['registrations']): WhoamiCustodySnapshot {
  return {
    readSet: {
      identity: { instanceId: 'instance', publicKeyPem: 'instance-key' },
      registrations,
    },
    operationFiles: [],
    service: {
      pid: 1,
      port: 1234,
      instanceId: 'instance',
      publicKeyPem: 'instance-key',
      exitCode: null,
      signalCode: null,
    },
    entrypoint: { sourcePath: 'source', path: 'bundle', sha256: 'a'.repeat(64) },
  }
}

function registrationRow(handle: string): WhoamiCustodySnapshot['readSet']['registrations'][number] {
  return { handle, inboundOpen: 0, agentPublicKeyPem: 'key', cardJson: null }
}

function whoamiStdout(handles: string[]): string {
  return JSON.stringify({
    instanceId: 'instance',
    registrations: handles.map((handle) => ({
      handle,
      address: `amtp://instance/${handle}`,
      inboundOpen: false,
      agentPublicKeyPem: 'key',
    })),
  })
}

function passingRun(stdout: string): Parameters<typeof runAuditedWhoami>[1]['run'] {
  return async () => ({
    command: ['bun', 'bundle', '--json', 'whoami'],
    capturePaths: ['stdout', 'stderr'] as const,
    pid: 2,
    exitCode: 0,
    signalCode: null,
    stdout,
    stderr: '',
    conformancePhases: [
      { operation: 'entrypoint', phase: 'module-loaded' },
      ...EXPECTED_WHOAMI_SUCCESS_PHASES.map((phase) => ({ operation: 'whoami', phase })),
    ],
  })
}

function staticDependencies(overrides: {
  snapshotBefore: Parameters<typeof runAuditedWhoami>[1]['snapshotBefore']
  snapshotAfter: Parameters<typeof runAuditedWhoami>[1]['snapshotAfter']
  run: Parameters<typeof runAuditedWhoami>[1]['run']
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Parameters<typeof runAuditedWhoami>[1] {
  return {
    now: overrides.now ?? (() => 1_000),
    operationId: () => '11111111-1111-4111-8111-111111111111',
    sleep: overrides.sleep ?? (async () => {}),
    snapshotBefore: overrides.snapshotBefore,
    run: overrides.run,
    assertCapturePathsGone: async () => {},
    snapshotAfter: overrides.snapshotAfter,
    assertServiceReady: async () => {},
  }
}

describe('scoped registration custody', () => {
  const scoped = registrationRow('scoped-cardless')
  const scope = (handle: string) => handle.startsWith('scoped-')

  test('ignores an out-of-scope registration appearing between snapshots', async () => {
    const before = custodySnapshot([scoped])
    const after = custodySnapshot([registrationRow('intruder-handle'), scoped])
    const result = await runAuditedWhoami(
      { handle: 'scoped-cardless', timeoutMs: 20_000, registrationScope: scope },
      staticDependencies({
        snapshotBefore: async () => before,
        // The intruder also shows up in the whoami stdout itself: the child
        // process read the database after the unrelated writer landed.
        run: passingRun(whoamiStdout(['intruder-handle', 'scoped-cardless'])),
        snapshotAfter: async () => after,
      })
    )
    expect(result.registrations.some(({ handle }) => handle === 'scoped-cardless')).toBe(true)
  })

  test('still fails when an in-scope registration appears between snapshots', async () => {
    const before = custodySnapshot([scoped])
    const after = custodySnapshot([scoped, registrationRow('scoped-extra')])
    await expect(
      runAuditedWhoami(
        { handle: 'scoped-cardless', timeoutMs: 20_000, registrationScope: scope },
        staticDependencies({
          snapshotBefore: async () => before,
          run: passingRun(whoamiStdout(['scoped-cardless'])),
          snapshotAfter: async () => after,
        })
      )
    ).rejects.toThrow('whoami-custody:read-set')
  })

  test("still fails when the audited handle's own row changes, even if the predicate excludes it", async () => {
    const before = custodySnapshot([scoped])
    const after = custodySnapshot([{ ...scoped, inboundOpen: 1 }])
    await expect(
      runAuditedWhoami(
        { handle: 'scoped-cardless', timeoutMs: 20_000, registrationScope: () => false },
        staticDependencies({
          snapshotBefore: async () => before,
          run: passingRun(whoamiStdout(['scoped-cardless'])),
          snapshotAfter: async () => after,
        })
      )
    ).rejects.toThrow('whoami-custody:read-set')
  })

  test('still fails when the identity changes, even out of registration scope', async () => {
    const before = custodySnapshot([scoped])
    const after = custodySnapshot([scoped])
    after.readSet.identity = { instanceId: 'instance', publicKeyPem: 'rotated-key' }
    await expect(
      runAuditedWhoami(
        { handle: 'scoped-cardless', timeoutMs: 20_000, registrationScope: scope },
        staticDependencies({
          snapshotBefore: async () => before,
          run: passingRun(whoamiStdout(['scoped-cardless'])),
          snapshotAfter: async () => after,
        })
      )
    ).rejects.toThrow('whoami-custody:read-set')
  })
})

describe('before-snapshot settlement quiescence', () => {
  const stable = custodySnapshot([registrationRow('cardless')])
  // A torn read: the prior scenario's registration write has not settled yet,
  // so the cardless row is missing. Accepting this read as the before-snapshot
  // would make the audit fail later (read-set or stdout custody).
  const torn = custodySnapshot([])

  test('re-polls past a torn first read, then the audit passes against the settled state', async () => {
    const reads = [torn, stable, stable]
    let readCount = 0
    let sleepCount = 0
    const result = await runAuditedWhoami(
      { handle: 'cardless', timeoutMs: 20_000 },
      staticDependencies({
        snapshotBefore: async () => {
          const read = reads[readCount]
          if (!read) throw new Error('unexpected extra snapshot read')
          readCount += 1
          return read
        },
        run: passingRun(whoamiStdout(['cardless'])),
        snapshotAfter: async () => stable,
        sleep: async () => {
          sleepCount += 1
        },
      })
    )
    expect(result.registrations.map(({ handle }) => handle)).toEqual(['cardless'])
    // Polled at least twice: the torn read was observed, rejected, and the
    // stable state had to repeat before the audit proceeded.
    expect(readCount).toBe(3)
    expect(sleepCount).toBe(2)
  })

  test('polls at least twice even when the first read is already stable', async () => {
    let readCount = 0
    await runAuditedWhoami(
      { handle: 'cardless', timeoutMs: 20_000 },
      staticDependencies({
        snapshotBefore: async () => {
          readCount += 1
          return stable
        },
        run: passingRun(whoamiStdout(['cardless'])),
        snapshotAfter: async () => stable,
      })
    )
    expect(readCount).toBe(2)
  })

  test('never-stabilizing snapshots exhaust the phase budget with the before-phase error', async () => {
    let now = 0
    let readCount = 0
    await expect(
      runAuditedWhoami(
        { handle: 'cardless', timeoutMs: 1_000 },
        staticDependencies({
          now: () => now,
          sleep: async (ms) => {
            now += ms
          },
          snapshotBefore: async () => {
            readCount += 1
            now += 250
            return custodySnapshot([registrationRow(`churning-${readCount}`)])
          },
          run: passingRun(whoamiStdout(['cardless'])),
          snapshotAfter: async () => stable,
        })
      )
    ).rejects.toThrow('whoami-custody:before')
    expect(readCount).toBeGreaterThanOrEqual(2)
  })
})

describe('real whoami lifecycle trace', () => {
  test('builds one owned runnable AMTP entrypoint', async () => {
    const artifactDir = await ownedDirectory('amtp-build-artifacts-')
    const captureDir = await ownedDirectory('amtp-build-captures-')
    const home = await ownedDirectory('amtp-built-parity-home-')
    const built = await buildAmtpConformanceEntrypoint({
      sourcePath: NODE_ENTRY,
      artifactDir,
      captureDir,
      timeoutMs: 5_000,
    })

    expect(built.path).toBe(join(artifactDir, 'amtp-node-conformance.mjs'))
    expect(built.sourcePath).toBe(NODE_ENTRY)
    expect(built.path).not.toBe(built.sourcePath)
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(built.exitCode).toBe(0)
    expect(built.signalCode).toBeNull()
    expect(await Bun.file(built.path).exists()).toBe(true)
    expect(await readdir(captureDir)).toEqual([])

    const operationId = '11111111-1111-4111-8111-111111111111'
    const command = (entrypoint: string, args: string[]) => [
      process.execPath,
      entrypoint,
      '--home',
      home,
      '--json',
      ...args,
    ]
    const init = await runFileCapturedProcess(command(NODE_ENTRY, ['init']), {
      phase: 'amtp-cli:init',
      timeoutMs: 2_000,
      captureDir,
    })
    expect(init.exitCode).toBe(0)
    const run = (entrypoint: string) =>
      runFileCapturedProcess(command(entrypoint, ['whoami']), {
        phase: 'amtp-cli:whoami',
        timeoutMs: 2_000,
        captureDir,
        env: { AMTP_CONFORMANCE_OPERATION_ID: operationId },
      })
    const source = await run(NODE_ENTRY)
    const bundle = await run(built.path)
    expect(bundle.stdout).toBe(source.stdout)
    expect(stripAmtpConformancePhases(bundle.stderr, operationId)).toBe(
      stripAmtpConformancePhases(source.stderr, operationId)
    )
    expect(amtpConformancePhases(bundle.stderr, operationId)).toEqual(amtpConformancePhases(source.stderr, operationId))
    expect(await readdir(captureDir)).toEqual([])
  })

  test('preserves output and emits correlated entrypoint and whoami phases', async () => {
    const home = await ownedDirectory('amtp-whoami-home-')
    const captureDir = await ownedDirectory('amtp-whoami-captures-')
    const command = (args: string[]) => [process.execPath, NODE_ENTRY, '--home', home, '--json', ...args]

    const init = await runFileCapturedProcess(command(['init']), {
      phase: 'amtp-cli:init',
      timeoutMs: 2_000,
      captureDir,
    })
    expect(init.exitCode).toBe(0)

    const untraced = await runFileCapturedProcess(command(['whoami']), {
      phase: 'amtp-cli:whoami',
      timeoutMs: 2_000,
      captureDir,
    })
    const operationId = '11111111-1111-4111-8111-111111111111'
    const traced = await runFileCapturedProcess(command(['whoami']), {
      phase: 'amtp-cli:whoami',
      timeoutMs: 2_000,
      captureDir,
      env: { AMTP_CONFORMANCE_OPERATION_ID: operationId },
    })

    expect(untraced.exitCode).toBe(0)
    expect(traced.exitCode).toBe(0)
    expect(traced.stdout).toBe(untraced.stdout)
    expect(untraced.stderr).toBe('')
    expect(amtpConformancePhases(traced.stderr, operationId)).toEqual([
      { operation: 'entrypoint', phase: 'module-loaded' },
      ...EXPECTED_WHOAMI_SUCCESS_PHASES.map((phase) => ({ operation: 'whoami', phase })),
    ])
    expect(stripAmtpConformancePhases(traced.stderr, operationId)).toBe(untraced.stderr)
    expect(await readdir(captureDir)).toEqual([])
  })
})
