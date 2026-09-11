import { describe, expect, test } from 'bun:test'
import { extractSignals, fingerprintFor } from './heuristics'

describe('operations heuristics', () => {
  test('turns a missing command and managed install into a package recommendation', () => {
    const signals = extractSignals({
      tools: [
        {
          messageId: 'm1',
          toolName: 'bash',
          args: JSON.stringify({ command: 'devbox add jq' }),
          result: 'bash: jq: command not found',
          isError: true,
          observedAt: new Date(),
        },
      ],
      inbox: [],
      knownSecrets: [],
    })
    expect(signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ remediation: { type: 'add_sandbox_package', package: 'jq' } })])
    )
  })
  test('does not turn credential-shaped install targets into evidence', () => {
    expect(
      extractSignals({
        tools: [
          {
            messageId: 'm1',
            toolName: 'bash',
            args: JSON.stringify({ command: 'devbox add https://user:token@host/pkg' }),
            result: '',
            isError: false,
            observedAt: new Date(),
          },
        ],
        inbox: [],
        knownSecrets: [],
      })
    ).toEqual([])
  })
  test('uses squad local deterministic fingerprints', () => {
    expect(fingerprintFor('squad-a', { type: 'add_sandbox_package', package: 'jq' })).not.toBe(
      fingerprintFor('squad-b', { type: 'add_sandbox_package', package: 'jq' })
    )
  })
})

describe('additional operations signals', () => {
  test('detects strict missing runtime modules but not generic missing files', () => {
    const base = { messageId: 'm', toolName: 'python', args: '{}', isError: true, observedAt: new Date() }
    expect(
      extractSignals({
        tools: [{ ...base, result: "ModuleNotFoundError: No module named 'yaml'" }],
        inbox: [],
        knownSecrets: [],
      })
    ).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'runtime_unavailable' })]))
    expect(
      extractSignals({
        tools: [{ ...base, result: 'No such file or directory: /private/secret' }],
        inbox: [],
        knownSecrets: [],
      })
    ).toEqual([])
  })
  test('requires both friction and workaround terms in inbox discussion', () => {
    const inbox = [
      { messageId: 'i', content: 'jq was missing so I used devbox add jq as a workaround', consumedAt: new Date() },
    ]
    expect(extractSignals({ tools: [], inbox, knownSecrets: [] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'workaround_discussion' })])
    )
    expect(extractSignals({ tools: [], inbox: [{ ...inbox[0], content: 'jq is useful' }], knownSecrets: [] })).toEqual(
      []
    )
  })
})

describe('signal-specific generated evidence', () => {
  test('distinguishes permission and repeated failures from unavailability', () => {
    const at = new Date()
    const tools = [
      { messageId: 'p1', toolName: 'bash', args: '{}', result: 'permission denied', isError: true, observedAt: at },
      { messageId: 'r1', toolName: 'read', args: '{}', result: 'temporary failure', isError: true, observedAt: at },
      { messageId: 'r2', toolName: 'read', args: '{}', result: 'temporary failure', isError: true, observedAt: at },
    ]
    const signals = extractSignals({ tools, inbox: [], knownSecrets: [] })
    expect(String(signals.find((s) => s.type === 'permission_failure')?.summary)).toBe(
      'bash encountered a sandbox permission failure'
    )
    expect(String(signals.find((s) => s.type === 'repeated_tool_failure')?.summary)).toBe(
      'read failed repeatedly in a completed execution'
    )
  })
  test('uses a fixed workaround-discussion template', () => {
    const [signal] = extractSignals({
      tools: [],
      inbox: [{ messageId: 'i1', content: 'tool missing; used devbox add as workaround', consumedAt: new Date() }],
      knownSecrets: [],
    })
    expect(signal.type).toBe('workaround_discussion')
    expect(String(signal.summary)).toBe('A consumed inter-agent message discussed an environment workaround')
  })
})
