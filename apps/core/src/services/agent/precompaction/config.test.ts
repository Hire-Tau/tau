import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_EARLY_MARGIN_TOKENS,
  DEFAULT_IN_FLIGHT_MARGIN_TOKENS,
  resolveEarlyMarginTokens,
  resolveInFlightMarginTokens,
  earlyThresholdReached,
} from './config'

describe('resolveEarlyMarginTokens', () => {
  it('returns the default for null/undefined', () => {
    expect(resolveEarlyMarginTokens(null)).toBe(DEFAULT_EARLY_MARGIN_TOKENS)
    expect(resolveEarlyMarginTokens(undefined)).toBe(DEFAULT_EARLY_MARGIN_TOKENS)
  })
  it('returns the default for non-finite values', () => {
    expect(resolveEarlyMarginTokens(NaN)).toBe(DEFAULT_EARLY_MARGIN_TOKENS)
    expect(resolveEarlyMarginTokens(Infinity)).toBe(DEFAULT_EARLY_MARGIN_TOKENS)
    expect(resolveEarlyMarginTokens(-Infinity)).toBe(DEFAULT_EARLY_MARGIN_TOKENS)
  })
  it('passes through a positive integer', () => {
    expect(resolveEarlyMarginTokens(30000)).toBe(30000)
  })
  it('floors fractional input', () => {
    expect(resolveEarlyMarginTokens(30000.9)).toBe(30000)
  })
  it('preserves zero and negatives (caller treats <=0 as disabled)', () => {
    expect(resolveEarlyMarginTokens(0)).toBe(0)
    expect(resolveEarlyMarginTokens(-5)).toBe(-5)
  })
})

describe('resolveInFlightMarginTokens', () => {
  it('returns the default for null/undefined', () => {
    expect(resolveInFlightMarginTokens(null)).toBe(DEFAULT_IN_FLIGHT_MARGIN_TOKENS)
    expect(resolveInFlightMarginTokens(undefined)).toBe(DEFAULT_IN_FLIGHT_MARGIN_TOKENS)
  })

  it('returns the default for non-finite values', () => {
    expect(resolveInFlightMarginTokens(NaN)).toBe(DEFAULT_IN_FLIGHT_MARGIN_TOKENS)
    expect(resolveInFlightMarginTokens(Infinity)).toBe(DEFAULT_IN_FLIGHT_MARGIN_TOKENS)
    expect(resolveInFlightMarginTokens(-Infinity)).toBe(DEFAULT_IN_FLIGHT_MARGIN_TOKENS)
  })

  it('floors fractional input', () => {
    expect(resolveInFlightMarginTokens(8192.9)).toBe(8192)
  })

  it('preserves zero and negatives (caller treats <=0 as disabled)', () => {
    expect(resolveInFlightMarginTokens(0)).toBe(0)
    expect(resolveInFlightMarginTokens(-5)).toBe(-5)
  })
})

describe('earlyThresholdReached', () => {
  const W = 200_000
  const reserve = 16_384
  const margin = 24_576 // pi triggers at W-reserve=183616; early at W-reserve-margin=159040

  it('is false below the early threshold', () => {
    expect(earlyThresholdReached(159_040, W, reserve, margin)).toBe(false)
  })
  it('is true just above the early threshold', () => {
    expect(earlyThresholdReached(159_041, W, reserve, margin)).toBe(true)
  })
  it('is hard-disabled when margin <= 0', () => {
    expect(earlyThresholdReached(199_999, W, reserve, 0)).toBe(false)
    expect(earlyThresholdReached(199_999, W, reserve, -1)).toBe(false)
  })
})
