import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_CONCURRENT_AGENTS_SETTING_KEY,
  MAX_MAX_CONCURRENT_AGENTS,
  MIN_MAX_CONCURRENT_AGENTS,
  envMaxConcurrentAgents,
  parseMaxConcurrentAgents,
  resolveMaxConcurrentAgents,
} from './max-concurrent'

describe('parseMaxConcurrentAgents', () => {
  test('accepts in-range integers', () => {
    expect(parseMaxConcurrentAgents('1')).toBe(1)
    expect(parseMaxConcurrentAgents('20')).toBe(20)
    expect(parseMaxConcurrentAgents(' 42 ')).toBe(42)
    expect(parseMaxConcurrentAgents(String(MAX_MAX_CONCURRENT_AGENTS))).toBe(MAX_MAX_CONCURRENT_AGENTS)
  })

  // Mutation caught: dropping the lower-bound check (or using `Number(x) || d`,
  // which turns '0' into the default silently at the READ path but would let a
  // literal 0 through validation) — a stored 0 halts every execution.
  test('rejects zero and negatives', () => {
    expect(parseMaxConcurrentAgents('0')).toBeNull()
    expect(parseMaxConcurrentAgents('-1')).toBeNull()
    expect(parseMaxConcurrentAgents('-999')).toBeNull()
  })

  // Mutation caught: replacing the parse with `Number(raw) || DEFAULT`, which
  // maps 'banana' -> NaN -> DEFAULT but ALSO maps '' and '0' to DEFAULT while
  // reporting them as valid at the write boundary.
  test('rejects non-numeric, empty, and nullish input', () => {
    expect(parseMaxConcurrentAgents('banana')).toBeNull()
    expect(parseMaxConcurrentAgents('')).toBeNull()
    expect(parseMaxConcurrentAgents('   ')).toBeNull()
    expect(parseMaxConcurrentAgents(null)).toBeNull()
    expect(parseMaxConcurrentAgents(undefined)).toBeNull()
    expect(parseMaxConcurrentAgents('NaN')).toBeNull()
    expect(parseMaxConcurrentAgents('Infinity')).toBeNull()
  })

  // Mutation caught: using parseInt, which happily returns 12 for '12.9' and
  // 12 for '12abc'.
  test('rejects non-integers and trailing garbage', () => {
    expect(parseMaxConcurrentAgents('12.9')).toBeNull()
    expect(parseMaxConcurrentAgents('12abc')).toBeNull()
    // Exponent notation still denotes an integer, so it is accepted.
    expect(parseMaxConcurrentAgents('1e2')).toBe(100)
  })

  // Mutation caught: dropping the upper bound — the cluster-saturation failure
  // mode this setting exists to prevent.
  test('rejects absurdly large values', () => {
    expect(parseMaxConcurrentAgents(String(MAX_MAX_CONCURRENT_AGENTS + 1))).toBeNull()
    expect(parseMaxConcurrentAgents('100000')).toBeNull()
    expect(parseMaxConcurrentAgents('9007199254740993')).toBeNull()
  })

  test('exposes the bounds it enforces', () => {
    expect(MIN_MAX_CONCURRENT_AGENTS).toBe(1)
    expect(MAX_MAX_CONCURRENT_AGENTS).toBeGreaterThan(MIN_MAX_CONCURRENT_AGENTS)
    expect(MAX_CONCURRENT_AGENTS_SETTING_KEY).toBe('MAX_CONCURRENT_AGENTS')
  })
})

describe('resolveMaxConcurrentAgents precedence', () => {
  // Mutation caught: flipping precedence so env wins — which would make the
  // UI setting a no-op on every real deployment (they all set the env var).
  test('a valid stored value wins over the env var', () => {
    expect(resolveMaxConcurrentAgents('5', '20')).toBe(5)
    expect(resolveMaxConcurrentAgents('200', '20')).toBe(200)
  })

  // Mutation caught: ignoring env entirely, which would silently RAISE this
  // instance's cap from 20 to 30 on deploy.
  test('the env var applies when nothing is stored', () => {
    expect(resolveMaxConcurrentAgents(undefined, '20')).toBe(20)
    expect(resolveMaxConcurrentAgents(null, '7')).toBe(7)
    expect(resolveMaxConcurrentAgents('', '7')).toBe(7)
  })

  // Mutation caught: changing the built-in fallback, i.e. today's behaviour on
  // an instance with neither a stored value nor the env var.
  test('falls back to the built-in default when neither is set', () => {
    expect(resolveMaxConcurrentAgents(undefined, undefined)).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
    expect(DEFAULT_MAX_CONCURRENT_AGENTS).toBe(30)
  })

  // Mutation caught: `Number(stored) || Number(env) || DEFAULT`, which yields
  // DEFAULT for a stored '0' but would ALSO happily return 0 if the fallback
  // chain were reordered; and a naive `?? ` chain that lets NaN through.
  test('an invalid stored value never yields 0 — it falls through to env', () => {
    expect(resolveMaxConcurrentAgents('0', '20')).toBe(20)
    expect(resolveMaxConcurrentAgents('-4', '20')).toBe(20)
    expect(resolveMaxConcurrentAgents('banana', '20')).toBe(20)
    expect(resolveMaxConcurrentAgents('999999', '20')).toBe(20)
  })

  test('an invalid stored value AND an invalid env value fall back to the default', () => {
    expect(resolveMaxConcurrentAgents('0', '0')).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
    expect(resolveMaxConcurrentAgents('banana', 'kumquat')).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
    expect(resolveMaxConcurrentAgents(undefined, '-3')).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
  })

  /**
   * The floor is the universal invariant — no pair of inputs may ever produce a
   * cap that halts the instance. The ceiling is NOT universal: it binds the
   * stored setting only (see the env-var-bounds describe below), so this
   * asserts it exactly where it applies rather than everywhere, and pins WHICH
   * source an above-ceiling result is allowed to come from.
   */
  test('never returns a non-positive number for any input pair', () => {
    const candidates = [undefined, null, '', '0', '-1', 'banana', '999999', '1', '30']
    for (const stored of candidates) {
      for (const env of candidates) {
        const envValue = env === null ? undefined : env
        const resolved = resolveMaxConcurrentAgents(stored, envValue)
        expect(resolved).toBeGreaterThanOrEqual(MIN_MAX_CONCURRENT_AGENTS)
        if (resolved > MAX_MAX_CONCURRENT_AGENTS) {
          // Only an operator-set env var may exceed the ceiling, and only by
          // being exactly the value the operator wrote.
          expect(parseMaxConcurrentAgents(stored)).toBeNull()
          expect(String(resolved)).toBe(String(envValue))
        }
      }
    }
  })

  // Mutation caught: dropping the ceiling from the stored branch, which the
  // matrix above no longer asserts unconditionally.
  test('a stored value never exceeds the ceiling, whatever the env var says', () => {
    for (const stored of ['501', '999999', '3000']) {
      for (const env of [undefined, '20', '1']) {
        expect(resolveMaxConcurrentAgents(stored, env)).not.toBe(Number(stored))
      }
    }
    expect(resolveMaxConcurrentAgents('501', '20')).toBe(20)
  })
})

/**
 * The ceiling is a guard on the UI-editable setting, NOT on the environment
 * variable.
 *
 * `MAX_CONCURRENT_AGENTS` is set by an operator in an EnvironmentFile at deploy
 * time, next to the CPU and memory sizing it has to agree with. Clamping it
 * would mean an instance running `MAX_CONCURRENT_AGENTS=1000` today silently
 * drops to a cap of 30 — a 33x capacity cut — the moment this feature ships,
 * with nothing the operator asked for to explain it. So env keeps passing
 * through: with nothing stored, the resolved cap matches the pre-setting
 * behaviour for every env value that behaviour accepted.
 *
 * Env is still required to be a whole number of at least 1, which is the one
 * deliberate divergence: `Number(env) || 30` used to return -3 for
 * `MAX_CONCURRENT_AGENTS=-3`, a negative cap that halts every execution on the
 * instance. That is a bug, not behaviour worth preserving.
 */
describe('resolveMaxConcurrentAgents env-var bounds', () => {
  // Mutation caught: applying MAX_MAX_CONCURRENT_AGENTS to the env branch —
  // the silent capacity cut described above.
  test('an above-ceiling env value passes through unclamped', () => {
    expect(resolveMaxConcurrentAgents(undefined, '1000')).toBe(1000)
    expect(resolveMaxConcurrentAgents(undefined, String(MAX_MAX_CONCURRENT_AGENTS + 1))).toBe(
      MAX_MAX_CONCURRENT_AGENTS + 1
    )
    expect(resolveMaxConcurrentAgents(null, '3000')).toBe(3000)
    expect(resolveMaxConcurrentAgents('', '3000')).toBe(3000)
  })

  // Mutation caught: bounding only the read path and forgetting that the STORED
  // value is the one an operator types into a web form.
  test('the ceiling still applies to the stored setting', () => {
    expect(parseMaxConcurrentAgents('1000')).toBeNull()
    // ...so an above-ceiling stored value falls through to env, which keeps it.
    expect(resolveMaxConcurrentAgents('1000', '900')).toBe(900)
    // A valid stored value still wins over an above-ceiling env value.
    expect(resolveMaxConcurrentAgents('5', '1000')).toBe(5)
  })

  // Mutation caught: dropping the floor/integer check on env along with the
  // ceiling, which would let `MAX_CONCURRENT_AGENTS=-3` yield a negative cap
  // (today's behaviour) and halt the instance.
  test.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '12.9'],
    ['non-numeric', '12abc'],
    ['infinite', 'Infinity'],
    ['whitespace', '   '],
  ])('an env value that is %s falls back to the built-in default', (_label, envValue) => {
    expect(resolveMaxConcurrentAgents(undefined, envValue)).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
  })

  test('an in-range env value is unaffected', () => {
    expect(resolveMaxConcurrentAgents(undefined, '1')).toBe(1)
    expect(resolveMaxConcurrentAgents(undefined, '20')).toBe(20)
    expect(resolveMaxConcurrentAgents(undefined, String(MAX_MAX_CONCURRENT_AGENTS))).toBe(MAX_MAX_CONCURRENT_AGENTS)
  })
})

describe('envMaxConcurrentAgents', () => {
  const original = process.env.MAX_CONCURRENT_AGENTS

  function restore(): void {
    if (original === undefined) delete process.env.MAX_CONCURRENT_AGENTS
    else process.env.MAX_CONCURRENT_AGENTS = original
  }

  // Mutation caught: reading process.env once at module scope — the value would
  // be frozen and this test would see the stale read.
  test('reads process.env at call time', () => {
    try {
      process.env.MAX_CONCURRENT_AGENTS = '11'
      expect(envMaxConcurrentAgents()).toBe(11)
      process.env.MAX_CONCURRENT_AGENTS = '12'
      expect(envMaxConcurrentAgents()).toBe(12)
      delete process.env.MAX_CONCURRENT_AGENTS
      expect(envMaxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
      process.env.MAX_CONCURRENT_AGENTS = 'nonsense'
      expect(envMaxConcurrentAgents()).toBe(DEFAULT_MAX_CONCURRENT_AGENTS)
    } finally {
      restore()
    }
  })
})
