/**
 * Pure parsing + aggregation for machine host metrics (CPU/memory/disk).
 *
 * No I/O, no clock, no SSH imports — everything here is a function of its
 * arguments. The sampling loop, push, storage, and alerting layers built on
 * top of this module own all of that; this module only turns raw command
 * output into typed samples and turns a window of samples into an aggregate.
 */

export interface RawMachineSample {
  load1: number | null
  memUsedMb: number | null
  memTotalMb: number | null
  diskUsedGb: number | null
  diskTotalGb: number | null
  /** Cumulative jiffies from /proc/stat's first line: [total, idle]. Null when unparseable. */
  cpuTotals: { total: number; idle: number } | null
}

export interface MachineMetricsAggregate {
  load1?: number
  cpuPctAvg?: number
  cpuPctPeak?: number
  memUsedMbAvg?: number
  memUsedMbPeak?: number
  memTotalMb?: number
  diskUsedGb?: number
  diskTotalGb?: number
}

/**
 * The single filesystem this codebase means by "the disk" for a machine
 * host. `/home` is the box-storage root (every box's HOME is
 * `/home/box_<hash>`, see box-paths.ts's `boxHomeForUser`), and machine
 * hosts are single-filesystem droplets, so `df /home` reports the same
 * filesystem a box actually fills up.
 *
 * Shared by TWO independent samples that must never disagree about WHICH
 * filesystem they describe: this module's {@link COMBINED_SAMPLE_COMMAND}
 * (feeding the usage-report `metrics` block a 60s-averaged window — the
 * graph/alert consumer) and machine-health.ts's `sampleMachineDiskUsage`
 * (a one-shot per-tick sample feeding the platform's storage guard, the
 * resize-eligibility gate). A customer must never see "plenty of space" on
 * the graph while the guard refuses a resize for insufficient space (or
 * vice versa) because the two samples quietly measured different
 * filesystems — hence exactly ONE constant, defined here (this module has
 * zero imports, so it's the natural shared leaf) and imported by
 * machine-health.ts rather than duplicated.
 */
export const DISK_SAMPLE_PATH = '/home'

export function buildCombinedSampleCommand(diskPath: string): string {
  return [
    'echo "###LOADAVG"; cat /proc/loadavg',
    'echo "###MEMINFO"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
    'echo "###STAT"; grep -E "^cpu " /proc/stat',
    `echo "###DF"; df -B1 --output=used,size ${diskPath} | tail -n +2`,
  ].join('; ')
}

export const COMBINED_SAMPLE_COMMAND = buildCombinedSampleCommand(DISK_SAMPLE_PATH)

const SECTION_MARKERS = ['###LOADAVG', '###MEMINFO', '###STAT', '###DF'] as const

/** Splits combined command output into its four fenced sections by marker line. */
function splitSections(output: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const lines = output.split('\n')
  let current: string | null = null
  let buf: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if ((SECTION_MARKERS as readonly string[]).includes(trimmed)) {
      if (current) sections[current] = buf.join('\n')
      current = trimmed
      buf = []
    } else if (current) {
      buf.push(line)
    }
  }
  if (current) sections[current] = buf.join('\n')
  return sections
}

function parseLoad1(section: string | undefined): number | null {
  if (!section) return null
  const match = section.trim().match(/^(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function parseMemUsedAndTotalMb(section: string | undefined): { memUsedMb: number | null; memTotalMb: number | null } {
  if (!section) return { memUsedMb: null, memTotalMb: null }

  const totalMatch = section.match(/^MemTotal:\s*(\d+)\s*kB$/m)
  const totalKb = totalMatch ? Number(totalMatch[1]) : NaN
  // MemTotal parses independently of MemAvailable — pre-3.14 kernels don't report MemAvailable
  // at all, and a missing/unparseable availability figure shouldn't discard a perfectly good total.
  const memTotalMb = totalMatch && Number.isFinite(totalKb) ? Math.floor(totalKb / 1024) : null

  const availMatch = section.match(/^MemAvailable:\s*(\d+)\s*kB$/m)
  let memUsedMb: number | null = null
  if (totalMatch && availMatch) {
    const availKb = Number(availMatch[1])
    if (Number.isFinite(totalKb) && Number.isFinite(availKb)) {
      const usedKb = totalKb - availKb
      // A negative delta (MemAvailable > MemTotal) happens transiently on cgroup-limited hosts
      // where the kernel's availability estimate slightly exceeds the reported total. Treat it
      // as unparseable rather than emitting a nonsensical negative "MB used".
      if (usedKb >= 0) memUsedMb = Math.floor(usedKb / 1024)
    }
  }

  return { memUsedMb, memTotalMb }
}

function parseCpuTotals(section: string | undefined): { total: number; idle: number } | null {
  if (!section) return null
  const match = section.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m)
  if (!match) return null
  const fields = match.slice(1).map(Number)
  if (fields.some((n) => !Number.isFinite(n))) return null
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  return { total, idle }
}

function parseDisk(section: string | undefined): { diskUsedGb: number | null; diskTotalGb: number | null } {
  if (!section) return { diskUsedGb: null, diskTotalGb: null }
  const line = section
    .trim()
    .split('\n')
    .find((l) => l.trim().length > 0)
  if (!line) return { diskUsedGb: null, diskTotalGb: null }
  const match = line.trim().match(/^(\d+)\s+(\d+)$/)
  if (!match) return { diskUsedGb: null, diskTotalGb: null }
  const usedBytes = Number(match[1])
  const totalBytes = Number(match[2])
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes)) return { diskUsedGb: null, diskTotalGb: null }
  const GB = 1024 * 1024 * 1024
  return {
    diskUsedGb: Math.floor(usedBytes / GB),
    diskTotalGb: Math.floor(totalBytes / GB),
  }
}

export function parseMachineSample(output: string): RawMachineSample {
  const sections = splitSections(output)
  const load1 = parseLoad1(sections['###LOADAVG'])
  const { memUsedMb, memTotalMb } = parseMemUsedAndTotalMb(sections['###MEMINFO'])
  const cpuTotals = parseCpuTotals(sections['###STAT'])
  const { diskUsedGb, diskTotalGb } = parseDisk(sections['###DF'])
  return { load1, memUsedMb, memTotalMb, diskUsedGb, diskTotalGb, cpuTotals }
}

export function cpuPctBetween(
  prev: { total: number; idle: number },
  next: { total: number; idle: number }
): number | null {
  const totalDelta = next.total - prev.total
  if (totalDelta <= 0) return null
  const idleDelta = next.idle - prev.idle
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100
  return Math.min(100, Math.max(0, pct))
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function last<T>(values: T[]): T {
  return values[values.length - 1]
}

function collectNonNull<K extends keyof RawMachineSample>(samples: RawMachineSample[], key: K): number[] {
  const out: number[] = []
  for (const s of samples) {
    const v = s[key]
    if (typeof v === 'number') out.push(v)
  }
  return out
}

export function aggregateSamples(samples: RawMachineSample[], cpuPcts: number[]): MachineMetricsAggregate {
  const agg: MachineMetricsAggregate = {}

  const load1Values = collectNonNull(samples, 'load1')
  if (load1Values.length > 0) agg.load1 = last(load1Values)

  const memUsedValues = collectNonNull(samples, 'memUsedMb')
  if (memUsedValues.length > 0) {
    // Rounded to the nearest whole MB: the platform's mem_used_mb_avg column
    // is `integer` (docs/history/superpowers/specs/2026-08-08-machine-metrics-design.md),
    // but this is a mean of up to five whole-MB sub-samples per 5-minute
    // tick, which is integral only when their sum happens to be a multiple
    // of the sample count — about 1 tick in 5 for a 5-sample window. Left
    // unrounded, ~80% of ticks would arrive at the platform with a
    // fractional value, and because a single invalid field drops the WHOLE
    // metrics block there (see ingest-metrics.ts's validateMetricsBlock),
    // the other 20% would be the only ticks that ever recorded ANY metric —
    // including load1/cpuPct*/disk/activity counts, which have nothing to
    // do with memory. Rounding a mean of whole-MB readings to the nearest
    // MB loses nothing meaningful. memUsedMbPeak (a max of already-integral
    // values) and memTotalMb (the last already-integral sample) need no
    // rounding; cpuPctAvg/cpuPctPeak below map to `real` columns and must
    // NOT be rounded.
    agg.memUsedMbAvg = Math.round(avg(memUsedValues))
    agg.memUsedMbPeak = Math.max(...memUsedValues)
  }

  const memTotalValues = collectNonNull(samples, 'memTotalMb')
  if (memTotalValues.length > 0) agg.memTotalMb = last(memTotalValues)

  const diskUsedValues = collectNonNull(samples, 'diskUsedGb')
  if (diskUsedValues.length > 0) agg.diskUsedGb = last(diskUsedValues)

  const diskTotalValues = collectNonNull(samples, 'diskTotalGb')
  if (diskTotalValues.length > 0) agg.diskTotalGb = last(diskTotalValues)

  if (cpuPcts.length > 0) {
    agg.cpuPctAvg = avg(cpuPcts)
    agg.cpuPctPeak = Math.max(...cpuPcts)
  }

  return agg
}
