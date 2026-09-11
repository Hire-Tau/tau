import { test, expect, spyOn } from 'bun:test'
import { buildCombinedSampleCommand, COMBINED_SAMPLE_COMMAND } from './machine-metrics-sample'
import { createMachineMetricsSampler } from './machine-metrics-sampler'

const out = (memAvail: number, idle: number, total: number) => `###LOADAVG
1.00 1 1 1/1 1
###MEMINFO
MemTotal:        4000000 kB
MemAvailable:    ${memAvail} kB
###STAT
cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0
###DF
1073741824 10737418240`

test('drain aggregates the ring and then empties it', async () => {
  const s = createMachineMetricsSampler({ exec: async () => out(2000000, 800, 1000) })
  await s.sample()
  await s.sample()
  const first = s.drain()
  expect(first.memUsedMbAvg).toBeGreaterThan(0)
  expect(s.drain()).toEqual({}) // ring emptied
})

test('the first sub-sample yields no cpu percentage; the second does', async () => {
  let idle = 800
  const s = createMachineMetricsSampler({ exec: async () => out(2000000, (idle += 25), 1000 + (idle - 800) * 4) })
  await s.sample()
  expect('cpuPctAvg' in s.drain()).toBe(false)
  await s.sample()
  await s.sample()
  expect('cpuPctAvg' in s.drain()).toBe(true)
})

test('uses a caller-supplied command and defaults to the machine command', async () => {
  const commands: string[] = []
  const exec = async (command: string) => {
    commands.push(command)
    return out(2000000, 800, 1000)
  }

  await createMachineMetricsSampler({ exec }).sample()
  await createMachineMetricsSampler({ exec, command: buildCombinedSampleCommand('/') }).sample()

  expect(commands).toEqual([COMBINED_SAMPLE_COMMAND, buildCombinedSampleCommand('/')])
})

test('skips an overlapping sample while the first execution is unresolved', async () => {
  let resolve!: (output: string) => void
  let calls = 0
  const pending = new Promise<string>((done) => {
    resolve = done
  })
  const sampler = createMachineMetricsSampler({
    exec: async () => {
      calls += 1
      return pending
    },
  })

  const first = sampler.sample()
  await sampler.sample()
  expect(calls).toBe(1)
  resolve(out(2000000, 800, 1000))
  await first
})

test('an exec failure skips the sub-sample without throwing or poisoning the aggregate', async () => {
  let call = 0
  const s = createMachineMetricsSampler({
    exec: async () => {
      call += 1
      if (call === 2) throw new Error('ssh down')
      return out(2000000, 800, 1000)
    },
  })
  await s.sample()
  await s.sample() // throws internally, must be swallowed
  await s.sample()
  const agg = s.drain()
  // 4000000kB - 2000000kB = 2000000kB = 1953MB (floor); verified against
  // parseMachineSample directly. Only the two good samples count in the
  // average, no zero dragged in.
  expect(agg.memUsedMbAvg).toBe(1953)
})

test('the ring is bounded at 16 sub-samples: FIFO drops the oldest, keeping the most recent 16', async () => {
  // memAvailable shrinks by 2048kB per call, so memUsedMb increases by exactly 2 per
  // call: floor((4000000 - (2000000 - i*2048)) / 1024) = 1953 + 2i for i = 0..39. The
  // step is 2, not 1, on purpose: with a step of 1 an off-by-one in RING_CAPACITY
  // (16 -> 15) averages exactly 1985.0, colliding with the correct FIFO-16 answer once
  // aggregateSamples rounds. A step of 2 keeps every candidate outcome a DISTINCT whole
  // number, so no rounding can blur two different behaviors into the same expectation.
  let i = -1
  const s = createMachineMetricsSampler({
    exec: async () => {
      i += 1
      return out(2000000 - i * 2048, 800, 1000)
    },
  })
  for (let call = 0; call < 40; call++) await s.sample()
  // A correctly bounded FIFO ring keeps calls 24..39 (memUsedMb 2001..2031), averaging
  // exactly 2016. Every mutation this test exists to catch lands somewhere else —
  // each value below was measured by actually applying the mutation, not predicted:
  //   unbounded ring (no eviction)                  -> 1992
  //   evicts the newest instead of the oldest (pop) -> 1971
  //   capacity off by one (15 instead of 16)        -> 2017
  expect(s.drain().memUsedMbAvg).toBe(2016)
})

test('the CPU percentage ring is bounded at 16 deltas using FIFO eviction', async () => {
  let call = 0
  let total = 1000
  let idle = 800
  const sampler = createMachineMetricsSampler({
    exec: async () => {
      const busyPct = call++
      total += 100
      idle += 100 - busyPct
      return out(2000000, idle, total)
    },
  })

  for (let i = 0; i < 21; i++) await sampler.sample()
  // The first sample establishes the baseline. A bounded FIFO keeps deltas 5..20.
  expect(sampler.drain().cpuPctAvg).toBe(12.5)
})

test('an all-null parse (garbage output with no section markers) is skipped like an exec failure', async () => {
  const s = createMachineMetricsSampler({ exec: async () => 'not a valid combined sample output at all' })
  await s.sample() // must not throw
  expect(s.drain()).toEqual({}) // nothing entered the ring
})

test('start() is idempotent and stop() clears the interval it created', () => {
  const s = createMachineMetricsSampler({ exec: async () => out(2000000, 800, 1000) })
  const setIntervalSpy = spyOn(global, 'setInterval')
  const clearIntervalSpy = spyOn(global, 'clearInterval')
  try {
    s.start()
    s.start() // idempotent: must not arm a second interval
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    const handle = setIntervalSpy.mock.results[0]?.value

    s.stop()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle) // clears the exact interval start() created

    s.stop() // idempotent: no interval left, so no further clearInterval call
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    s.start() // re-arms after stop(); proves the internal handle was actually reset, not leaked
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    s.stop()
  } finally {
    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  }
})
