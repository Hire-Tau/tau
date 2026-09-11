import { describe, expect, it } from 'bun:test'
import { reconcileRemoteToolchain } from './remote-adapter'

function clientHarness(marker = '', activationFails = false, activationGate?: Promise<void>) {
  const calls: string[] = []
  const client = {
    read: async ({ path }: { path: string }) => ({
      content: Buffer.from(path.endsWith('.ready') ? marker : '').toString('base64'),
    }),
    write: async ({ path }: { path: string }) => void calls.push(`write:${path.split('/').pop()}`),
    bash: ({ command }: { command: string }) => {
      calls.push(
        command.startsWith('rm ')
          ? command.includes('setup.sh')
            ? 'remove-setup'
            : 'clear-marker'
          : command.includes('devbox install')
            ? 'install'
            : command.includes('ntn --version')
              ? 'readiness'
              : 'setup'
      )
      const stream = new EventTarget() as any
      queueMicrotask(() => {
        stream.dispatchEvent(new MessageEvent('data', { data: { exitCode: 0 } }))
        stream.dispatchEvent(new Event('end'))
      })
      stream.on = (event: string, listener: (value?: unknown) => void) => {
        stream.addEventListener(event, (value: MessageEvent) => listener(value.data))
        return stream
      }
      stream.cancel = () => {}
      return stream
    },
    toolchainReady: async () => {
      calls.push('activate')
      await activationGate
      if (activationFails) throw new Error('secret raw activation output')
    },
  }
  return { client: client as any, calls }
}

describe('remote managed toolchain adapter', () => {
  it('skips progress for a current marker even while refreshing activation', async () => {
    const gate = Promise.withResolvers<void>()
    const { client, calls } = clientHarness('fingerprint', false, gate.promise)
    let tracked = 0
    const reconciliation = reconcileRemoteToolchain(
      client,
      '/toolchain',
      '/workspace',
      {
        config: { packages: ['a'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async () => {},
      },
      async (operation) => {
        tracked++
        return operation()
      }
    )
    await Bun.sleep(1)
    expect(calls).toEqual(['activate'])
    expect(tracked).toBe(0)
    gate.resolve()
    await expect(reconciliation).resolves.toBe('unchanged')
  })

  it('runs readiness even when the fingerprint marker is unchanged', async () => {
    const { client, calls } = clientHarness('fingerprint')
    expect(
      await reconcileRemoteToolchain(client, '/toolchain', '/workspace', {
        config: { packages: ['nodejs@24.12.0'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        readiness: [{ id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.22.10' }],
        reportStage: async () => {},
      })
    ).toBe('unchanged')
    expect(calls).toEqual(['readiness', 'activate'])
  })

  it('orders install, setup, activation, then marker inside reported mutation work', async () => {
    const { client, calls } = clientHarness()
    const stages: string[] = []
    const progress: string[] = []
    await reconcileRemoteToolchain(
      client,
      '/toolchain',
      '/workspace',
      {
        config: { packages: ['a'], setupScript: 'echo ready' },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async (stage) => void stages.push(stage),
      },
      async (operation) => {
        progress.push('started')
        const result = await operation()
        progress.push('finished')
        return result
      }
    )
    expect(stages).toEqual(['installing', 'running_setup'])
    expect(calls).toEqual([
      'clear-marker',
      'write:devbox.json',
      'write:setup.sh',
      'install',
      'setup',
      'activate',
      'write:.ready',
    ])
    expect(progress).toEqual(['started', 'finished'])
  })

  it('removes an obsolete setup script when replacement omits it', async () => {
    const { client, calls } = clientHarness()
    await reconcileRemoteToolchain(client, '/toolchain', '/workspace', {
      config: { packages: ['a'] },
      fingerprint: 'fingerprint',
      devboxJson: '{}',
      reportStage: async () => {},
    })
    expect(calls).toContain('remove-setup')
    expect(calls).not.toContain('write:setup.sh')
  })

  it('reports failed mutation and does not write the marker when activation fails', async () => {
    const { client, calls } = clientHarness('', true)
    const progress: string[] = []
    await expect(
      reconcileRemoteToolchain(
        client,
        '/toolchain',
        '/workspace',
        {
          config: { packages: ['a'] },
          fingerprint: 'fingerprint',
          devboxJson: '{}',
          reportStage: async () => {},
        },
        async (operation) => {
          progress.push('started')
          try {
            return await operation()
          } catch (error) {
            progress.push('finished:failed')
            throw error
          }
        }
      )
    ).rejects.toMatchObject({ code: 'activation_failed' })
    expect(calls).not.toContain('write:.ready')
    expect(progress).toEqual(['started', 'finished:failed'])
  })
})
