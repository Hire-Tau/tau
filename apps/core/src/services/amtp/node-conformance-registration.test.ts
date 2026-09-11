import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { amtpNodeCommand } from './node-conformance-command'
import {
  assertNodeRegistration,
  establishNodeMailbox,
  inspectNodeRegistration,
  type RawNodeRegistration,
} from './node-conformance-registration'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})

const openRow: RawNodeRegistration = {
  handle: 'alice',
  agent_public_key_pem: 'key-a',
  inbound_open: 1,
}

describe('assertNodeRegistration', () => {
  test('accepts only the exact open handle and public key', () => {
    expect(
      assertNodeRegistration(openRow, {
        handle: 'alice',
        agentPublicKeyPem: 'key-a',
        inboundOpen: true,
      })
    ).toBeUndefined()
  })

  test('rejects a closed mailbox before protocol send', () => {
    expect(() =>
      assertNodeRegistration(
        { ...openRow, inbound_open: 0 },
        { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }
      )
    ).toThrow('node-mailbox-ready')
  })

  test.each([2, -1])('rejects noncanonical inbound_open value %i', (inboundOpen) => {
    expect(() =>
      assertNodeRegistration(
        { ...openRow, inbound_open: inboundOpen },
        { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }
      )
    ).toThrow('inboundOpenMatches=false')
  })

  test('rejects a stale/different public key', () => {
    expect(() =>
      assertNodeRegistration(
        { ...openRow, agent_public_key_pem: 'stale' },
        { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }
      )
    ).toThrow('publicKeyMatches=false')
  })
})

describe('establishNodeMailbox', () => {
  test('registers once, audits the exact open row, then proves the live server key within one deadline', async () => {
    const calls: string[] = []
    let now = 1_000
    const expected = { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }

    await establishNodeMailbox(expected, 20_000, {
      now: () => now,
      operationId: () => '11111111-1111-4111-8111-111111111111',
      runRegister: async ({ operationId, timeoutMs }) => {
        calls.push(`register:${timeoutMs}:${operationId}`)
        now += 250
        return expected
      },
      inspectRegistration: () => {
        calls.push('sqlite')
        now += 50
        return openRow
      },
      waitForServerKey: async ({ timeoutMs }) => {
        calls.push(`http:${timeoutMs}`)
      },
    })

    expect(calls).toEqual(['register:20000:11111111-1111-4111-8111-111111111111', 'sqlite', 'http:19700'])
  })

  test('applies the same audited server-visible barrier to a closed registration', async () => {
    const calls: string[] = []
    const registered = { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: false }

    await establishNodeMailbox({ handle: 'alice', inboundOpen: false }, 20_000, {
      now: () => 1_000,
      operationId: () => '11111111-1111-4111-8111-111111111111',
      runRegister: async () => {
        calls.push('register')
        return registered
      },
      inspectRegistration: () => {
        calls.push('sqlite')
        return { ...openRow, inbound_open: 0 }
      },
      waitForServerKey: async ({ registration }) => {
        calls.push('http')
        expect(registration).toEqual(registered)
      },
    })

    expect(calls).toEqual(['register', 'sqlite', 'http'])
  })

  test('does not start the SQLite audit after the absolute deadline expires', async () => {
    let now = 1_000
    let inspected = false
    const expected = { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }

    await expect(
      establishNodeMailbox(expected, 20_000, {
        now: () => now,
        operationId: () => crypto.randomUUID(),
        runRegister: async () => {
          now = 21_000
          return expected
        },
        inspectRegistration: () => {
          inspected = true
          return openRow
        },
        waitForServerKey: async () => {},
      })
    ).rejects.toThrow('budget exhausted before sqlite audit')
    expect(inspected).toBeFalse()
  })

  test('does not start server visibility after the absolute deadline expires', async () => {
    let now = 1_000
    let serverKeyCalls = 0
    const expected = { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }

    await expect(
      establishNodeMailbox(expected, 20_000, {
        now: () => now,
        operationId: () => crypto.randomUUID(),
        runRegister: async () => expected,
        inspectRegistration: () => {
          now = 21_000
          return openRow
        },
        waitForServerKey: async () => {
          serverKeyCalls += 1
        },
      })
    ).rejects.toThrow('budget exhausted before server visibility')
    expect(serverKeyCalls).toBe(0)
  })

  test('does not retry registration when the audited mailbox is closed', async () => {
    let registrationCalls = 0
    const expected = { handle: 'alice', agentPublicKeyPem: 'key-a', inboundOpen: true }

    await expect(
      establishNodeMailbox(expected, 20_000, {
        now: () => 1_000,
        operationId: () => '11111111-1111-4111-8111-111111111111',
        runRegister: async () => {
          registrationCalls += 1
          return expected
        },
        inspectRegistration: () => ({ ...openRow, inbound_open: 0 }),
        waitForServerKey: async () => {
          throw new Error('must not reach HTTP readiness')
        },
      })
    ).rejects.toThrow('node-mailbox-ready')
    expect(registrationCalls).toBe(1)
  })
})

describe('inspectNodeRegistration', () => {
  test('reads only the requested registration from a real initialized node home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'amtp-registration-test-'))
    dirs.push(home)
    const nodeEntry = Bun.resolveSync('amtp-node', import.meta.dir)

    const init = Bun.spawnSync(amtpNodeCommand(process.execPath, nodeEntry, ['--home', home, '--json', 'init']))
    expect(init.exitCode).toBe(0)
    const register = Bun.spawnSync(
      amtpNodeCommand(process.execPath, nodeEntry, ['--home', home, '--json', 'register', 'alice', '--open'])
    )
    expect(register.exitCode).toBe(0)
    const parsed = JSON.parse(register.stdout.toString()) as { agentPublicKeyPem: string }

    expect(inspectNodeRegistration(home, 'missing')).toBeNull()
    expect(inspectNodeRegistration(home, 'alice')).toEqual({
      handle: 'alice',
      agent_public_key_pem: parsed.agentPublicKeyPem,
      inbound_open: 1,
    })
  })
})
