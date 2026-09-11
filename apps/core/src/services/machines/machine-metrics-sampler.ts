/**
 * 60-second sub-sampler loop built on top of {@link ./machine-metrics-sample}'s
 * pure parsing/aggregation. Owns the only stateful pieces: a bounded ring of
 * raw sub-samples, the running CPU-jiffies baseline used to turn consecutive
 * `/proc/stat` totals into a percentage, and the `setInterval` that drives it.
 *
 * `sample()` never throws — an exec rejection or an all-null parse just skips
 * that sub-sample so a sampling hiccup can never break the reporter above.
 */

import { createLogger } from '../../lib/infra/logger'
import {
  COMBINED_SAMPLE_COMMAND,
  aggregateSamples,
  cpuPctBetween,
  parseMachineSample,
  type MachineMetricsAggregate,
  type RawMachineSample,
} from './machine-metrics-sample'

const log = createLogger('machine-metrics-sampler')

export const SUB_SAMPLE_INTERVAL_MS = 60_000

/** Ring capacity — bounds memory if the reporter stalls and stops draining. */
const RING_CAPACITY = 16

export interface MachineMetricsSampler {
  /** Take one sub-sample now. Never throws. */
  sample: () => Promise<void>
  /** Aggregate + CLEAR the ring. Returns {} when the ring is empty. */
  drain: () => MachineMetricsAggregate
  start: () => void
  stop: () => void
}

export function createMachineMetricsSampler(deps: {
  exec: (command: string) => Promise<string>
  /** Command to execute for each sample. Defaults to the machine-host command. */
  command?: string
  /** Reserved for future use — not currently wired into interval timing (a real `setInterval` drives sub-sampling). */
  now?: () => number
}): MachineMetricsSampler {
  const ring: RawMachineSample[] = []
  const cpuPcts: number[] = []
  let cpuBaseline: { total: number; idle: number } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let sampling = false

  const sample = async (): Promise<void> => {
    if (sampling) return
    sampling = true

    let output: string
    try {
      output = await deps.exec(deps.command ?? COMBINED_SAMPLE_COMMAND)
    } catch (err) {
      log.warn('sub-sample exec failed, skipping:', err)
      return
    } finally {
      sampling = false
    }

    const parsed = parseMachineSample(output)
    // Resilient to the pure module's RawMachineSample interface growing a field: a
    // manual field-by-field enumeration here would silently stop covering a new field.
    const allNull = Object.values(parsed).every((v) => v === null)
    if (allNull) {
      log.warn('sub-sample parsed to all-null fields, skipping')
      return
    }

    if (ring.length >= RING_CAPACITY) ring.shift()
    ring.push(parsed)

    if (parsed.cpuTotals) {
      if (cpuBaseline) {
        const pct = cpuPctBetween(cpuBaseline, parsed.cpuTotals)
        if (pct !== null) {
          if (cpuPcts.length >= RING_CAPACITY) cpuPcts.shift()
          cpuPcts.push(pct)
        }
      }
      cpuBaseline = parsed.cpuTotals
    }
  }

  const drain = (): MachineMetricsAggregate => {
    const agg = aggregateSamples(ring, cpuPcts)
    ring.length = 0
    cpuPcts.length = 0
    return agg
  }

  const start = (): void => {
    if (timer) return
    timer = setInterval(() => {
      void sample()
    }, SUB_SAMPLE_INTERVAL_MS)
  }

  const stop = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { sample, drain, start, stop }
}
