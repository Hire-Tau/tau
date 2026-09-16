import { describe, expect, test } from 'bun:test'
import { pushAlertText, relayRoutingSchema, type RelayRouting } from './push-relay'

describe('relay routing presentation keys', () => {
  const routing = {
    eventType: 'done',
    workStreamNumber: 197,
    preview: { title: 'Completed: #197 · Validate deletion', body: 'ship it', subtitle: 'Platform' },
    collapseKey: 'ws:abc',
    threadKey: 'squad:def',
    interruptionLevel: 'passive',
  } satisfies RelayRouting
  const rejects = (value: unknown) => relayRoutingSchema.safeParse(value).success === false

  test('accepts a preview subtitle and grouping keys, and still rejects unknown keys', () => {
    expect(relayRoutingSchema.parse(routing)).toEqual(routing)
    expect(rejects({ ...routing, sound: 'loud' })).toBe(true)
    expect(rejects({ ...routing, interruptionLevel: 'loud' })).toBe(true)
    expect(rejects({ ...routing, preview: { ...routing.preview, extra: 1 } })).toBe(true)
  })

  test('pushAlertText returns the preview subtitle only when a preview is present', () => {
    expect(
      pushAlertText({ eventType: 'done', workStreamNumber: 197, preview: { title: 'T', body: 'B', subtitle: 'S' } })
    ).toEqual({ title: 'T', body: 'B', subtitle: 'S' })
    expect(pushAlertText({ eventType: 'done', workStreamNumber: 197 })).toEqual({
      title: 'Work #197 completed',
      body: 'Open Tau to see details.',
    })
  })
})
