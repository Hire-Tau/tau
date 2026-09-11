import { describe, test, expect } from 'bun:test'
import { shouldParkBox, type IdleCandidate } from './idle'

// A base candidate that WOULD park (ready, not always-on, tracked, past timeout);
// each test flips exactly one field to exercise a single branch.
function candidate(overrides: Partial<IdleCandidate> = {}): IdleCandidate {
  return {
    sandboxId: 'agent_a1',
    lastActivityAt: 0,
    idleTimeoutMs: 1000,
    alwaysOn: false,
    boxStatus: 'ready',
    ...overrides,
  }
}

const never = async () => false
const always = async () => true

describe('shouldParkBox', () => {
  test('parks a past-timeout, all-clear box', async () => {
    expect(await shouldParkBox(candidate(), 2000, never)).toBe(true)
  })

  test('does not park a non-ready box', async () => {
    expect(await shouldParkBox(candidate({ boxStatus: 'starting' }), 2000, never)).toBe(false)
    expect(await shouldParkBox(candidate({ boxStatus: 'stopped' }), 2000, never)).toBe(false)
  })

  test('does not park an always-on box', async () => {
    expect(await shouldParkBox(candidate({ alwaysOn: true }), 2000, never)).toBe(false)
  })

  test('does not park a box with undefined lastActivityAt (untracked skip)', async () => {
    expect(await shouldParkBox(candidate({ lastActivityAt: undefined }), 2000, never)).toBe(false)
  })

  test('does not park a box the keepalive predicate wants kept warm', async () => {
    expect(await shouldParkBox(candidate(), 2000, always)).toBe(false)
  })

  test('does not park a box still within its idle timeout', async () => {
    // now - lastActivityAt === idleTimeoutMs is still "within" (not strictly past).
    expect(await shouldParkBox(candidate({ lastActivityAt: 1000 }), 2000, never)).toBe(false)
    expect(await shouldParkBox(candidate({ lastActivityAt: 1500 }), 2000, never)).toBe(false)
  })

  test('does not consult keepAlive for a box excluded by a cheaper branch', async () => {
    let called = false
    const spy = async () => {
      called = true
      return false
    }
    await shouldParkBox(candidate({ alwaysOn: true }), 2000, spy)
    await shouldParkBox(candidate({ lastActivityAt: undefined }), 2000, spy)
    await shouldParkBox(candidate({ boxStatus: 'stopped' }), 2000, spy)
    expect(called).toBe(false)
  })
})
