import { describe, expect, it, spyOn } from 'bun:test'
import * as connections from './connection'
import { withVmSetupLease } from '../services/sandbox/vm/setup-state'
import { withPinnedProvisionLease, withProvisionLease } from '../services/sandbox/toolchain/state'
import { ConnectionAuthorizationLease } from '../services/integrations/authorization/connection-lease'

describe('runtime dedicated connection budget', () => {
  it('queues VM, toolchain, and integration leases before opening connections when the shared budget is full', async () => {
    const release = Promise.withResolvers<void>()
    const holders = [0, 1].map(() => connections.withDedicatedConnectionSlot(() => release.promise))
    const create = connections.createPostgresConnection
    const factory = spyOn(connections, 'createPostgresConnection').mockImplementation(create)
    const key = crypto.randomUUID()
    const operations = [
      withVmSetupLease(key, async () => 'vm'),
      withProvisionLease(key, async () => 'toolchain'),
      new ConnectionAuthorizationLease().runExclusive(key, async () => 'integration'),
    ]
    try {
      // Each API synchronously reaches the slot gate before its first await.
      // The old implementations already created three extra pools here.
      expect(factory).not.toHaveBeenCalled()
      release.resolve()
      expect(await Promise.all(operations)).toEqual(['vm', 'toolchain', 'integration'])
      expect(factory).toHaveBeenCalledTimes(3)
    } finally {
      release.resolve()
      await Promise.allSettled([...holders, ...operations])
      factory.mockRestore()
    }
  })

  it('closes a toolchain pool even when reserving the connection fails', async () => {
    let ended = false
    let ran = false
    await expect(
      withPinnedProvisionLease(
        'failed-reserve',
        async () => {
          ran = true
        },
        {
          reserve: async () => {
            throw new Error('connection unavailable')
          },
          end: async () => {
            ended = true
          },
        }
      )
    ).rejects.toThrow('connection unavailable')
    expect(ended).toBe(true)
    expect(ran).toBe(false)
  })
})
