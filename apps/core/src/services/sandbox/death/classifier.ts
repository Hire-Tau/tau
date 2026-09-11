import { getSquadIdFromSandbox } from '../types'
import { terminationIntentRegistry } from './intent-registry'
import type { SandboxDeathClassification, SandboxDeathObservation, TerminationIntentReason } from './types'

export interface ClassifyOptions {
  consumeIntent?: (sandboxId: string) => TerminationIntentReason | null
}

export function classifySandboxDeath(
  obs: SandboxDeathObservation,
  opts: ClassifyOptions = {}
): SandboxDeathClassification {
  // Check the real cause (recorded intent, then OOM) BEFORE the non-squad
  // short-circuit. The halt path classifies solo `agent_<id>` deaths too and
  // needs the genuine cause: 'intentional' so a manual stop reads as a clean
  // recreate rather than a crash, and 'oom' so a solo OOM still trips the
  // give-up backstop. Only deaths with no recorded intent and no OOM signal
  // fall through to the non-squad 'ignored' (the notifier still guards
  // squad-only notifications separately via getSquadIdFromSandbox).
  const consumeIntent = opts.consumeIntent ?? ((sandboxId: string) => terminationIntentRegistry.consume(sandboxId))
  if (consumeIntent(obs.sandboxId) !== null) return 'intentional'
  if (isOomDeath(obs)) return 'oom'
  if (getSquadIdFromSandbox(obs.sandboxId) === null) return 'ignored'
  return 'unexpected'
}

function isOomDeath(obs: SandboxDeathObservation): boolean {
  // Exit code 137 is the conventional OOM-kill exit code.
  if (obs.exitCode === 137) return true

  const reason = obs.reason?.toLowerCase() ?? ''
  const message = obs.message?.toLowerCase() ?? ''
  const details = `${reason} ${message}`

  // Direct container OOM: an explicit OOM reason or a memory mention in the
  // reason/message. Covers 'OOMKilled', 'out of memory', and node-eviction
  // messages that mention memory (e.g. 'low on resource: memory').
  if (details.includes('oom') || details.includes('memory')) return true

  // Node-level memory-pressure eviction: an evicted pod whose reason/message
  // points at memory pressure without literally containing 'memory' (e.g.
  // kubelet 'MinimumFreeSpace'). Pods evicted for other reasons (NodeLost,
  // disk pressure, ...) fall through to 'unexpected'.
  const isEvicted = obs.signal === 'evicted' || reason === 'evicted'
  if (!isEvicted) return false

  return details.includes('minimumfreespace')
}
