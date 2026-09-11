import { formatAmtpAddress } from 'amtp-protocol'
import type { FileCapturedProcessResult } from './node-conformance-process'

type OwnedFileCapturedProcessResult = FileCapturedProcessResult & {
  readonly command: readonly string[]
  readonly capturePaths: readonly [string, string]
}

export interface WhoamiReadSet {
  identity: { instanceId: string; publicKeyPem: string }
  registrations: Array<{
    handle: string
    inboundOpen: 0 | 1
    agentPublicKeyPem: string
    cardJson: string | null
  }>
}

export interface WhoamiCustodySnapshot {
  readSet: WhoamiReadSet
  operationFiles: string[]
  service: {
    pid: number
    port: number
    instanceId: string
    publicKeyPem: string
    exitCode: null
    signalCode: null
  }
  entrypoint: { sourcePath: string; path: string; sha256: string }
}

interface WhoamiRegistration {
  handle: string
  address: string
  inboundOpen: boolean
  agentPublicKeyPem: string
  name?: string
}

export interface WhoamiResult {
  instanceId: string
  registrations: WhoamiRegistration[]
}

function parseWhoamiJson(stdout: string): WhoamiResult | undefined {
  try {
    const value: unknown = JSON.parse(stdout)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'instanceId,registrations') return undefined
    if (typeof record.instanceId !== 'string' || !Array.isArray(record.registrations)) return undefined
    const registrations: WhoamiRegistration[] = []
    for (const candidate of record.registrations) {
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const registration = candidate as Record<string, unknown>
      const keys = Object.keys(registration).sort().join(',')
      if (
        keys !== 'address,agentPublicKeyPem,handle,inboundOpen' &&
        keys !== 'address,agentPublicKeyPem,handle,inboundOpen,name'
      )
        return undefined
      if (
        typeof registration.handle !== 'string' ||
        typeof registration.address !== 'string' ||
        typeof registration.inboundOpen !== 'boolean' ||
        typeof registration.agentPublicKeyPem !== 'string' ||
        ('name' in registration && typeof registration.name !== 'string')
      )
        return undefined
      registrations.push(registration as unknown as WhoamiRegistration)
    }
    return { instanceId: record.instanceId, registrations }
  } catch {
    return undefined
  }
}

export function isCompleteWhoamiJson(stdout: string, targetHandle: string): boolean {
  const result = parseWhoamiJson(stdout)
  return result !== undefined && result.registrations.filter(({ handle }) => handle === targetHandle).length === 1
}

export const WHOAMI_SUCCESS_TRACE = Object.freeze([
  { operation: 'entrypoint', phase: 'module-loaded' },
  ...[
    'process:start',
    'sqlite-open:start',
    'sqlite-open:done',
    'identity-read:start',
    'identity-read:done',
    'registrations-read:start',
    'registrations-read:done',
    'response-write:start',
    'response-write:done',
    'sqlite-close:start',
    'sqlite-close:done',
  ].map((phase) => ({ operation: 'whoami', phase })),
])

export function assertExactWhoamiPhases(phases: Array<{ operation: string; phase: string }>): void {
  if (JSON.stringify(phases) !== JSON.stringify(WHOAMI_SUCCESS_TRACE)) throw new Error('whoami-custody:phase-order')
}

function cardName(cardJson: string | null): string | undefined {
  if (!cardJson) return undefined
  try {
    const parsed = JSON.parse(cardJson) as { card?: { name?: unknown } }
    return typeof parsed.card?.name === 'string' ? parsed.card.name : undefined
  } catch {
    return undefined
  }
}

function expectedWhoami(readSet: WhoamiReadSet): WhoamiResult {
  return {
    instanceId: readSet.identity.instanceId,
    registrations: readSet.registrations.map((row) => {
      const registration: WhoamiRegistration = {
        handle: row.handle,
        address: formatAmtpAddress(readSet.identity.instanceId, row.handle),
        inboundOpen: row.inboundOpen === 1,
        agentPublicKeyPem: row.agentPublicKeyPem,
      }
      const name = cardName(row.cardJson)
      if (name !== undefined) registration.name = name
      return registration
    }),
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function scopedReadSet(readSet: WhoamiReadSet, scope: ((handle: string) => boolean) | undefined): WhoamiReadSet {
  if (!scope) return readSet
  return {
    identity: readSet.identity,
    registrations: readSet.registrations.filter((row) => scope(row.handle)),
  }
}

function scopedWhoami(result: WhoamiResult, scope: ((handle: string) => boolean) | undefined): WhoamiResult {
  if (!scope) return result
  return {
    instanceId: result.instanceId,
    registrations: result.registrations.filter((registration) => scope(registration.handle)),
  }
}

const QUIESCENCE_INTERVAL_MS = 100

export async function runAuditedWhoami(
  options: {
    handle: string
    timeoutMs: number
    expectedCommand?: readonly string[]
    /**
     * Restricts the registrations half of the custody comparisons (before vs
     * after read-set, and stdout vs expected) to handles the predicate
     * accepts. The audited handle itself is always in scope, and the
     * identity/service/entrypoint/operation-file custody stays global. Pass
     * this ONLY where the test design permits concurrent unrelated
     * registration writers; leave it unset for the stronger global check.
     */
    registrationScope?: (handle: string) => boolean
  },
  dependencies: {
    now: () => number
    operationId: () => string
    sleep: (ms: number) => Promise<void>
    snapshotBefore: (options: { remainingMs: number }) => Promise<WhoamiCustodySnapshot>
    run: (options: {
      operationId: string
      timeoutMs: number
    }) => Promise<OwnedFileCapturedProcessResult & { conformancePhases: Array<{ operation: string; phase: string }> }>
    assertCapturePathsGone: (paths: readonly [string, string], options: { remainingMs: number }) => Promise<void>
    snapshotAfter: (options: { remainingMs: number }) => Promise<WhoamiCustodySnapshot>
    assertServiceReady: (options: { remainingMs: number }) => Promise<void>
  }
): Promise<WhoamiResult> {
  const deadline = dependencies.now() + options.timeoutMs
  const remaining = (phase: string): number => {
    const value = deadline - dependencies.now()
    if (value <= 0) throw new Error(`whoami-custody:${phase}`)
    return value
  }
  const providedScope = options.registrationScope
  const scope = providedScope
    ? (handle: string): boolean => handle === options.handle || providedScope(handle)
    : undefined
  const custodyView = (snapshot: WhoamiCustodySnapshot): WhoamiCustodySnapshot => ({
    ...snapshot,
    readSet: scopedReadSet(snapshot.readSet, scope),
  })
  // Quiescence barrier: a prior scenario's registration/card writes may settle
  // in the shared serve process after its dispose barrier. Poll until two
  // consecutive snapshots agree (on the custody view this audit will compare)
  // so late settlement lands before the before-snapshot is frozen, not
  // between the before and after snapshots.
  let before = await dependencies.snapshotBefore({ remainingMs: remaining('before') })
  for (;;) {
    await dependencies.sleep(QUIESCENCE_INTERVAL_MS)
    const next = await dependencies.snapshotBefore({ remainingMs: remaining('before') })
    if (same(custodyView(before), custodyView(next))) {
      before = next
      break
    }
    before = next
  }
  const process = await dependencies.run({
    operationId: dependencies.operationId(),
    timeoutMs: remaining('run'),
  })
  await dependencies.assertCapturePathsGone(process.capturePaths, { remainingMs: remaining('captures') })
  const after = await dependencies.snapshotAfter({ remainingMs: remaining('after') })
  await dependencies.assertServiceReady({ remainingMs: remaining('service-ready') })
  remaining('assertions')

  if (process.exitCode !== 0 || process.signalCode !== null) throw new Error('whoami-custody:child-exit')
  if (options.expectedCommand && !same(process.command, options.expectedCommand))
    throw new Error('whoami-custody:command')
  assertExactWhoamiPhases(process.conformancePhases)
  if (!same(before.readSet.identity, after.readSet.identity)) throw new Error('whoami-custody:read-set')
  if (!same(scopedReadSet(before.readSet, scope), scopedReadSet(after.readSet, scope)))
    throw new Error('whoami-custody:read-set')
  if (!same(before.operationFiles, after.operationFiles)) throw new Error('whoami-custody:operation-files')
  if (!same(before.service, after.service)) throw new Error('whoami-custody:service')
  if (!same(before.entrypoint, after.entrypoint)) throw new Error('whoami-custody:entrypoint')
  const parsed = parseWhoamiJson(process.stdout)
  if (!parsed || !same(scopedWhoami(parsed, scope), scopedWhoami(expectedWhoami(before.readSet), scope)))
    throw new Error('whoami-custody:stdout')
  const targetRows = before.readSet.registrations.filter(({ handle }) => handle === options.handle)
  const targetOutputs = parsed.registrations.filter(({ handle }) => handle === options.handle)
  if (
    targetRows.length !== 1 ||
    targetRows[0]?.cardJson !== null ||
    targetOutputs.length !== 1 ||
    targetOutputs[0]?.name !== undefined
  )
    throw new Error('whoami-custody:target-cardless')
  return parsed
}
