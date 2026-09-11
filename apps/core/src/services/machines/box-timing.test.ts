import { describe, test, expect } from 'bun:test'
import { BOX_STEP_ORDER, createBoxStepTimer, formatBoxReadyLine } from './box-timing'

describe('formatBoxReadyLine', () => {
  test('renders every canonical step (0.0s when unrecorded) plus a computed other bucket, in a stable order', () => {
    const line = formatBoxReadyLine('agent_x', 'm1', 500, {}, { role: 'agent' })
    expect(line).toBe(
      'Box ready: agent_x on machine m1 in 0.5s (' +
        BOX_STEP_ORDER.map((s) => `${s} 0.0s`).join(', ') +
        ', other 0.5s) role=agent priorBoxesOnMachine=n/a'
    )
  })

  test('renders recorded steps at one decimal place and subtracts them from total to get other', () => {
    const line = formatBoxReadyLine(
      'agent_x',
      'm1',
      42_300,
      { identity: 120, artifacts: 800, 'devbox-realize': 31_500, assets: 2_100 },
      { role: 'agent', priorBoxesOnMachine: 3 }
    )
    // accounted = 120 + 800 + 31500 + 2100 = 34520ms -> other = 42300 - 34520 = 7780ms = 7.8s
    expect(line).toContain('Box ready: agent_x on machine m1 in 42.3s (')
    expect(line).toContain('identity 0.1s')
    expect(line).toContain('artifacts 0.8s')
    expect(line).toContain('devbox-realize 31.5s')
    expect(line).toContain('assets 2.1s')
    expect(line).toContain('other 7.8s')
    expect(line).toContain('role=agent priorBoxesOnMachine=3')
  })

  test('floors other at zero when recorded steps exceed the wall-clock total (clock/attempt-retry skew)', () => {
    const line = formatBoxReadyLine('agent_x', 'm1', 100, { placement: 50, tunnel: 100 }, { role: 'agent' })
    expect(line).toContain('other 0.0s')
  })

  test('keeps step order identical across calls regardless of key insertion order in the input', () => {
    const a = formatBoxReadyLine('a', 'm1', 100, { 'devbox-realize': 10, identity: 5 }, { role: 'squad' })
    const b = formatBoxReadyLine('a', 'm1', 100, { identity: 5, 'devbox-realize': 10 }, { role: 'squad' })
    expect(a).toBe(b)
  })

  test('renders priorBoxesOnMachine as n/a when the (fast-path) ensure never computed it, and as a number otherwise', () => {
    const noAnnotation = formatBoxReadyLine('a', 'm1', 100, {}, { role: 'agent' })
    expect(noAnnotation).toContain('priorBoxesOnMachine=n/a')
    const annotated = formatBoxReadyLine('a', 'm1', 100, {}, { role: 'agent', priorBoxesOnMachine: 0 })
    expect(annotated).toContain('priorBoxesOnMachine=0')
  })

  test('splits devbox into distinct resolve/realize buckets and a separate devbox-ready bucket', () => {
    expect(BOX_STEP_ORDER).toContain('devbox-resolve')
    expect(BOX_STEP_ORDER).toContain('devbox-realize')
    expect(BOX_STEP_ORDER).toContain('devbox-ready')
    // No plain aggregate 'devbox' bucket — resolve + realize ARE the full picture,
    // so a caller can never double-count by also recording a coarse total.
    expect(BOX_STEP_ORDER as readonly string[]).not.toContain('devbox')
  })
})

describe('createBoxStepTimer', () => {
  function fakeClock(...ticks: number[]) {
    let i = 0
    return () => {
      const t = ticks[i]
      i++
      return t
    }
  }

  test('time() records the elapsed duration for a step using the injected clock', async () => {
    const timer = createBoxStepTimer(fakeClock(1000, 1300))
    const result = await timer.time('artifacts', async () => 'ok')
    expect(result).toBe('ok')
    expect(timer.steps.artifacts).toBe(300)
  })

  test('time() accumulates across repeated calls to the same step (e.g. a retried placement loop)', async () => {
    const timer = createBoxStepTimer(fakeClock(0, 100, 100, 250))
    await timer.time('placement', async () => {})
    await timer.time('placement', async () => {})
    expect(timer.steps.placement).toBe(250)
  })

  test('time() still records duration when the wrapped function throws', async () => {
    const timer = createBoxStepTimer(fakeClock(0, 40))
    await expect(
      timer.time('provision', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(timer.steps.provision).toBe(40)
  })

  test('record() adds a duration directly without wrapping a function', () => {
    const timer = createBoxStepTimer(() => 0)
    timer.record('health', 75)
    timer.record('health', 25)
    expect(timer.steps.health).toBe(100)
  })

  test("merge() folds a sub-timer's BoxStepTimings (e.g. ensureBox/seedBoxDevbox's returned breakdown) into this timer, accumulating on collision", () => {
    const timer = createBoxStepTimer(() => 0)
    timer.record('assets', 10)
    timer.merge({ 'devbox-resolve': 40, 'devbox-realize': 300 })
    timer.merge(undefined)
    expect(timer.steps).toEqual({ assets: 10, 'devbox-resolve': 40, 'devbox-realize': 300 })
  })
})
