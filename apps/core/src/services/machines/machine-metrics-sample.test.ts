import { describe, test, expect } from 'bun:test'
import {
  parseMachineSample,
  cpuPctBetween,
  aggregateSamples,
  COMBINED_SAMPLE_COMMAND,
  DISK_SAMPLE_PATH,
  buildCombinedSampleCommand,
  type RawMachineSample,
} from './machine-metrics-sample'

const FULL = `###LOADAVG
0.52 0.44 0.39 2/431 12345
###MEMINFO
MemTotal:        4022336 kB
MemAvailable:    2515968 kB
###STAT
cpu  100 0 50 800 0 0 0 0 0 0
###DF
5368709120 81604378624`

describe('parseMachineSample', () => {
  test('parses every section of a well-formed combined sample', () => {
    const s = parseMachineSample(FULL)
    expect(s.load1).toBe(0.52)
    // 4022336kB - 2515968kB = 1506368kB = 1471MB (floor)
    expect(s.memUsedMb).toBe(1471)
    expect(s.memTotalMb).toBe(3928)
    expect(s.diskUsedGb).toBe(5)
    expect(s.diskTotalGb).toBe(76)
    expect(s.cpuTotals).toEqual({ total: 950, idle: 800 })
  })

  test('a missing section yields null for its fields — never zero', () => {
    const s = parseMachineSample('###LOADAVG\n0.10 0.1 0.1 1/1 1\n###MEMINFO\n###STAT\n###DF\n')
    expect(s.load1).toBe(0.1)
    expect(s.memUsedMb).toBeNull()
    expect(s.memTotalMb).toBeNull()
    expect(s.diskUsedGb).toBeNull()
    expect(s.cpuTotals).toBeNull()
  })

  test('garbage output yields all nulls rather than throwing', () => {
    const s = parseMachineSample('bash: /proc/loadavg: Permission denied')
    expect(s).toEqual({
      load1: null,
      memUsedMb: null,
      memTotalMb: null,
      diskUsedGb: null,
      diskTotalGb: null,
      cpuTotals: null,
    })
  })

  test('the combined command reads all four sources in ONE exec', () => {
    expect(COMBINED_SAMPLE_COMMAND).toContain('/proc/loadavg')
    expect(COMBINED_SAMPLE_COMMAND).toContain('/proc/meminfo')
    expect(COMBINED_SAMPLE_COMMAND).toContain('/proc/stat')
    expect(COMBINED_SAMPLE_COMMAND).toContain('df')
  })

  test('the combined command samples the SAME filesystem the disk report does — one shared DISK_SAMPLE_PATH, not a second hardcoded path', () => {
    expect(DISK_SAMPLE_PATH).toBe('/home')
    expect(COMBINED_SAMPLE_COMMAND).toContain(`df -B1 --output=used,size ${DISK_SAMPLE_PATH}`)
    expect(buildCombinedSampleCommand('/')).toContain('df -B1 --output=used,size / | tail -n +2')
  })

  test('a negative computed usedKb (MemAvailable > MemTotal) yields memUsedMb null, never negative', () => {
    const s = parseMachineSample(
      '###LOADAVG\n0.1 0.1 0.1 1/1 1\n###MEMINFO\nMemTotal:        1000000 kB\nMemAvailable:    1000001 kB\n###STAT\n###DF\n'
    )
    expect(s.memUsedMb).toBeNull()
    // MemTotal itself was perfectly parseable — it must not be discarded alongside memUsedMb.
    expect(s.memTotalMb).toBe(976)
  })

  test('memTotalMb parses independently of MemAvailable (pre-3.14 kernels lack MemAvailable)', () => {
    const s = parseMachineSample(
      '###LOADAVG\n0.1 0.1 0.1 1/1 1\n###MEMINFO\nMemTotal:        4022336 kB\n###STAT\n###DF\n'
    )
    expect(s.memTotalMb).toBe(3928)
    expect(s.memUsedMb).toBeNull()
  })
})

describe('cpuPctBetween', () => {
  test('computes utilisation from jiffy deltas', () => {
    // total +100, idle +25 -> 75% busy
    expect(cpuPctBetween({ total: 1000, idle: 900 }, { total: 1100, idle: 925 })).toBe(75)
  })
  test('returns null when the counter did not advance (reset or wrap)', () => {
    expect(cpuPctBetween({ total: 1000, idle: 900 }, { total: 1000, idle: 900 })).toBeNull()
    expect(cpuPctBetween({ total: 1000, idle: 900 }, { total: 500, idle: 400 })).toBeNull()
  })
  test('clamps to 100 when idle regresses while total advances (pct > 100 pre-clamp)', () => {
    // totalDelta=100, idleDelta=-50 -> raw pct = (100-(-50))/100*100 = 150
    expect(cpuPctBetween({ total: 1000, idle: 900 }, { total: 1100, idle: 850 })).toBe(100)
  })
  test('clamps to 0 when idleDelta exceeds totalDelta (pct < 0 pre-clamp)', () => {
    // totalDelta=10, idleDelta=900 -> raw pct = (10-900)/10*100 = -8900
    expect(cpuPctBetween({ total: 1000, idle: 0 }, { total: 1010, idle: 900 })).toBe(0)
  })
})

describe('aggregateSamples', () => {
  const s = (over: Partial<RawMachineSample>): RawMachineSample => ({
    load1: null,
    memUsedMb: null,
    memTotalMb: null,
    diskUsedGb: null,
    diskTotalGb: null,
    cpuTotals: null,
    ...over,
  })

  test('averages and peaks memory, keeps the last total, and carries cpu percentages', () => {
    const agg = aggregateSamples(
      [s({ memUsedMb: 100, memTotalMb: 4000 }), s({ memUsedMb: 300, memTotalMb: 4000 })],
      [10, 90]
    )
    expect(agg.memUsedMbAvg).toBe(200)
    expect(agg.memUsedMbPeak).toBe(300)
    expect(agg.memTotalMb).toBe(4000)
    expect(agg.cpuPctAvg).toBe(50)
    expect(agg.cpuPctPeak).toBe(90)
  })

  test('a field with no non-null samples is OMITTED, never 0', () => {
    const agg = aggregateSamples([s({ memUsedMb: 10, memTotalMb: 100 })], [])
    expect('diskUsedGb' in agg).toBe(false)
    expect('cpuPctAvg' in agg).toBe(false)
    expect('cpuPctPeak' in agg).toBe(false)
  })

  test('an empty ring aggregates to an empty object', () => {
    expect(aggregateSamples([], [])).toEqual({})
  })

  test('nulls inside a partially-failed ring do not drag the average toward zero', () => {
    const agg = aggregateSamples([s({ memUsedMb: 100 }), s({}), s({ memUsedMb: 200 })], [])
    expect(agg.memUsedMbAvg).toBe(150) // (100+200)/2, NOT (100+0+200)/3
  })

  test('memUsedMbAvg is ROUNDED to the nearest whole MB — the platform column is integer-typed, and a mean over 5 whole-MB sub-samples is rarely integral', () => {
    const agg = aggregateSamples(
      [
        s({ memUsedMb: 1471 }),
        s({ memUsedMb: 1472 }),
        s({ memUsedMb: 1470 }),
        s({ memUsedMb: 1473 }),
        s({ memUsedMb: 1471 }),
      ],
      []
    )
    // (1471+1472+1470+1473+1471)/5 = 7357/5 = 1471.4 -> rounds to 1471
    expect(agg.memUsedMbAvg).toBe(1471)
    expect(Number.isInteger(agg.memUsedMbAvg)).toBe(true)
  })

  test('cpuPctAvg is NOT rounded — it maps to a `real` platform column, unlike the mem/disk integer columns', () => {
    const agg = aggregateSamples([], [10, 21])
    expect(agg.cpuPctAvg).toBe(15.5)
  })
})
