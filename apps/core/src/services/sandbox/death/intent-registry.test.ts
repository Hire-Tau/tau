import { describe, expect, test } from 'bun:test'
import { TerminationIntentRegistry } from './intent-registry'

describe('TerminationIntentRegistry', () => {
  test('consume returns a recorded intent once, then null', () => {
    const reg = new TerminationIntentRegistry(120_000)
    reg.record('squad_a', 'idle')
    expect(reg.consume('squad_a')).toBe('idle')
    expect(reg.consume('squad_a')).toBeNull()
  })

  test('expired intents are ignored', () => {
    const reg = new TerminationIntentRegistry(1_000)
    reg.record('squad_a', 'manual')
    expect(reg.consume('squad_a', Date.now() + 2_000)).toBeNull()
  })
})
