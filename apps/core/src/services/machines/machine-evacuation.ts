import { createHash, randomUUID } from 'crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, machineBoxes, machineEvacuationBoxes, machineEvacuations, machines } from '../../db'
import { getMachine } from './queries'
import { defaultSshRunner } from './ssh'

const DIGEST = /^[a-f0-9]{64}$/
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function listMachineHostBoxUsers(machineId: string): Promise<string[]> {
  const machine = await getMachine(machineId)
  if (!machine) throw new Error('machine not found for host inventory')
  const result = await defaultSshRunner.run(
    machine,
    `getent passwd | cut -d: -f1 | grep -E '^box_[0-9a-f]{12}$' || true`
  )
  if (result.exitCode !== 0) throw new Error('source host inventory failed')
  const users = result.stdout.split('\n').filter(Boolean)
  if (users.some((user) => !/^box_[0-9a-f]{12}$/.test(user)) || new Set(users).size !== users.length)
    throw new Error('source host inventory corrupt')
  return users.sort()
}
export interface BeginMachineEvacuationInput {
  operationId: string
  sourceMachineId: string
  targetMachineId: string
  sourceGeneration: number | null
  targetGeneration: number | null
  hostUnixUsers?: string[]
}

export interface EvacuationReceipt {
  operationId: string
  sourceMachineId: string
  targetMachineId: string
  sourceGeneration: number | null
  targetGeneration: number | null
  rosterDigest: string
  manifestDigest: string
  verifiedAt: string
}

export async function beginMachineEvacuation(input: BeginMachineEvacuationInput) {
  const hostUnixUsers = (input.hostUnixUsers ?? (await listMachineHostBoxUsers(input.sourceMachineId))).toSorted()
  if (input.sourceMachineId === input.targetMachineId) throw new Error('evacuation source and target must differ')
  return db.transaction(async (tx) => {
    const existing = await tx.query.machineEvacuations.findFirst({
      where: eq(machineEvacuations.id, input.operationId),
    })
    if (existing) {
      if (
        existing.sourceMachineId !== input.sourceMachineId ||
        existing.targetMachineId !== input.targetMachineId ||
        existing.sourceGeneration !== input.sourceGeneration ||
        existing.targetGeneration !== input.targetGeneration
      )
        throw new Error('evacuation operation identity mismatch')
      const roster = await tx
        .select()
        .from(machineEvacuationBoxes)
        .where(eq(machineEvacuationBoxes.evacuationId, existing.id))
        .orderBy(machineEvacuationBoxes.sandboxId)
      return { ...existing, roster }
    }
    const drained = await tx
      .update(machines)
      .set({ status: 'draining' })
      .where(and(eq(machines.id, input.sourceMachineId), eq(machines.status, 'ready')))
      .returning()
    if (drained.length !== 1) throw new Error('source machine is not ready')
    const boxes = await tx
      .select({ sandboxId: machineBoxes.sandboxId, unixUser: machineBoxes.unixUser })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, input.sourceMachineId))
      .orderBy(machineBoxes.sandboxId)
    const dbUnixUsers = boxes.map(({ unixUser }) => unixUser).toSorted()
    if (JSON.stringify(dbUnixUsers) !== JSON.stringify(hostUnixUsers)) throw new Error('inventory-mismatch')
    const rosterDigest = digest(boxes)
    const [operation] = await tx
      .insert(machineEvacuations)
      .values({
        id: input.operationId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        sourceGeneration: input.sourceGeneration,
        targetGeneration: input.targetGeneration,
        rosterDigest,
        fencingToken: randomUUID(),
        state: 'inventoried',
      })
      .returning()
    if (boxes.length)
      await tx.insert(machineEvacuationBoxes).values(boxes.map((box) => ({ evacuationId: operation.id, ...box })))
    return { ...operation, roster: boxes }
  })
}

export async function recordEvacuationBoxProof(input: {
  evacuationId: string
  sandboxId: string
  manifestDigest: string
  files: number
  bytes: string
}) {
  if (
    !DIGEST.test(input.manifestDigest) ||
    !Number.isSafeInteger(input.files) ||
    input.files < 0 ||
    !/^(0|[1-9][0-9]*)$/.test(input.bytes)
  )
    throw new Error('invalid evacuation proof')
  return db.transaction(async (tx) => {
    const parent = await tx
      .update(machineEvacuations)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(machineEvacuations.id, input.evacuationId),
          sql`${machineEvacuations.state} in ('inventoried', 'migrating')`
        )
      )
      .returning()
    if (parent.length !== 1) throw new Error('evacuation no longer accepts box proofs')
    const existing = await tx.query.machineEvacuationBoxes.findFirst({
      where: and(
        eq(machineEvacuationBoxes.evacuationId, input.evacuationId),
        eq(machineEvacuationBoxes.sandboxId, input.sandboxId)
      ),
    })
    if (!existing) throw new Error('evacuation box is not in the frozen roster')
    if (existing.verified) {
      if (
        existing.manifestDigest !== input.manifestDigest ||
        existing.files !== input.files ||
        existing.bytes !== input.bytes
      )
        throw new Error('evacuation box proof is immutable')
      return existing
    }
    const [updated] = await tx
      .update(machineEvacuationBoxes)
      .set({
        manifestDigest: input.manifestDigest,
        files: input.files,
        bytes: input.bytes,
        verified: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(machineEvacuationBoxes.evacuationId, input.evacuationId),
          eq(machineEvacuationBoxes.sandboxId, input.sandboxId),
          eq(machineEvacuationBoxes.verified, false)
        )
      )
      .returning()
    if (!updated) throw new Error('evacuation box proof CAS lost')
    return updated
  })
}

export async function verifyMachineEvacuation(
  evacuationId: string,
  deps: { listHostUsers?: typeof listMachineHostBoxUsers; requireSourceUsersAbsent?: boolean } = {}
): Promise<EvacuationReceipt> {
  const operationSnapshot = await db.query.machineEvacuations.findFirst({
    where: eq(machineEvacuations.id, evacuationId),
  })
  if (!operationSnapshot) throw new Error('evacuation not found')
  const sourceHostUsers = await (deps.listHostUsers ?? listMachineHostBoxUsers)(operationSnapshot.sourceMachineId)
  return db.transaction(async (tx) => {
    const operation = await tx.query.machineEvacuations.findFirst({ where: eq(machineEvacuations.id, evacuationId) })
    if (!operation) throw new Error('evacuation not found')
    if (operation.state === 'verified' && operation.manifestDigest && operation.verifiedAt) {
      if (deps.requireSourceUsersAbsent !== false && sourceHostUsers.length !== 0) throw new Error('inventory-mismatch')
      return receipt(operation)
    }
    if (operation.state !== 'inventoried' && operation.state !== 'migrating' && operation.state !== 'verifying')
      throw new Error('evacuation cannot be verified')
    if (operation.state !== 'verifying') {
      const claimed = await tx
        .update(machineEvacuations)
        .set({ state: 'verifying', updatedAt: new Date() })
        .where(
          and(
            eq(machineEvacuations.id, operation.id),
            eq(machineEvacuations.state, operation.state),
            eq(machineEvacuations.fencingToken, operation.fencingToken)
          )
        )
        .returning()
      if (claimed.length !== 1) throw new Error('evacuation verification CAS lost')
      operation.state = 'verifying'
    }
    const children = await tx
      .select()
      .from(machineEvacuationBoxes)
      .where(eq(machineEvacuationBoxes.evacuationId, evacuationId))
      .orderBy(machineEvacuationBoxes.sandboxId)
    if (children.some((child) => !child.verified || !child.manifestDigest))
      throw new Error('evacuation verification incomplete')
    const expectedRoster = children.map(({ sandboxId, unixUser }) => ({ sandboxId, unixUser }))
    // Compare complete machine-scoped inventories. Filtering to frozen IDs
    // would hide a concurrently-created row/user and could authorize deletion.
    const remainingSource = await tx
      .select({ sandboxId: machineBoxes.sandboxId, unixUser: machineBoxes.unixUser })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, operation.sourceMachineId))
      .orderBy(machineBoxes.sandboxId)
    if (remainingSource.length) throw new Error('evacuation source roster is not empty')
    if (deps.requireSourceUsersAbsent !== false && sourceHostUsers.length !== 0) throw new Error('inventory-mismatch')
    const targetRoster = await tx
      .select({ sandboxId: machineBoxes.sandboxId, unixUser: machineBoxes.unixUser })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, operation.targetMachineId))
      .orderBy(machineBoxes.sandboxId)
    if (digest(targetRoster) !== digest(expectedRoster) || digest(expectedRoster) !== operation.rosterDigest)
      throw new Error('evacuation roster changed')
    const manifestDigest = digest(children.map(({ sandboxId, manifestDigest }) => ({ sandboxId, manifestDigest })))
    const files = children.reduce((sum, child) => sum + child.files, 0)
    const bytes = children.reduce((sum, child) => sum + BigInt(child.bytes), 0n).toString()
    const verifiedAt = new Date()
    const updated = await tx
      .update(machineEvacuations)
      .set({ state: 'verified', manifestDigest, files, bytes, verifiedAt, updatedAt: verifiedAt })
      .where(
        and(
          eq(machineEvacuations.id, operation.id),
          eq(machineEvacuations.state, operation.state),
          eq(machineEvacuations.fencingToken, operation.fencingToken),
          eq(machineEvacuations.rosterDigest, operation.rosterDigest)
        )
      )
      .returning()
    if (updated.length !== 1) throw new Error('evacuation verification CAS lost')
    return receipt(updated[0])
  })
}

function receipt(operation: typeof machineEvacuations.$inferSelect): EvacuationReceipt {
  if (!operation.manifestDigest || !operation.verifiedAt) throw new Error('verified evacuation has incomplete receipt')
  return {
    operationId: operation.id,
    sourceMachineId: operation.sourceMachineId,
    targetMachineId: operation.targetMachineId,
    sourceGeneration: operation.sourceGeneration,
    targetGeneration: operation.targetGeneration,
    rosterDigest: operation.rosterDigest,
    manifestDigest: operation.manifestDigest,
    verifiedAt: operation.verifiedAt.toISOString(),
  }
}

export async function authorizeEvacuationSourceDeletion(
  receiptInput: EvacuationReceipt,
  deps: { listHostUsers?: typeof listMachineHostBoxUsers } = {}
): Promise<{ providerTerminationRequired: boolean; reconciliationRequired?: boolean }> {
  const snapshot = await db.query.machineEvacuations.findFirst({
    where: eq(machineEvacuations.id, receiptInput.operationId),
  })
  if (!snapshot || !snapshot.manifestDigest || !snapshot.verifiedAt)
    throw new Error('evacuation verification incomplete')
  if (JSON.stringify(receipt(snapshot)) !== JSON.stringify(receiptInput)) throw new Error('verification receipt stale')
  if (snapshot.sourceGeneration === null || snapshot.targetGeneration === null)
    throw new Error('manual evacuation cannot authorize machine deletion')
  if (snapshot.state === 'source-terminated') return { providerTerminationRequired: false }
  if (snapshot.state === 'source-terminating')
    return { providerTerminationRequired: false, reconciliationRequired: true }
  if (snapshot.state !== 'verified' && snapshot.state !== 'source-delete-authorized')
    throw new Error('evacuation verification incomplete')

  // Re-sample on every authorization/replay before provider termination. The
  // source remains draining, fencing box creation across check-to-delete.
  const sourceHostUsers = await (deps.listHostUsers ?? listMachineHostBoxUsers)(receiptInput.sourceMachineId)
  if (sourceHostUsers.length !== 0) throw new Error('inventory-mismatch')
  return db.transaction(async (tx) => {
    const operation = await tx.query.machineEvacuations.findFirst({
      where: eq(machineEvacuations.id, receiptInput.operationId),
    })
    if (!operation || !operation.manifestDigest || !operation.verifiedAt)
      throw new Error('evacuation verification incomplete')
    if (JSON.stringify(receipt(operation)) !== JSON.stringify(receiptInput))
      throw new Error('verification receipt stale')
    if (operation.state === 'source-terminated') return { providerTerminationRequired: false }
    if (operation.state === 'source-terminating')
      return { providerTerminationRequired: false, reconciliationRequired: true }
    if (operation.state !== 'verified' && operation.state !== 'source-delete-authorized')
      throw new Error('evacuation verification incomplete')
    const sourceMachine = await tx.query.machines.findFirst({ where: eq(machines.id, operation.sourceMachineId) })
    if (sourceMachine?.status !== 'draining') throw new Error('source machine creation fence is not held')
    const remaining = await tx
      .select({ sandboxId: machineBoxes.sandboxId })
      .from(machineBoxes)
      .where(eq(machineBoxes.machineId, operation.sourceMachineId))
    if (remaining.length) throw new Error('evacuation source roster is not empty')
    if (operation.state === 'verified' || operation.state === 'source-delete-authorized') {
      const priorState = operation.state
      const updated = await tx
        .update(machineEvacuations)
        .set({ state: 'source-terminating', updatedAt: new Date() })
        .where(
          and(
            eq(machineEvacuations.id, operation.id),
            eq(machineEvacuations.state, priorState),
            eq(machineEvacuations.fencingToken, operation.fencingToken),
            eq(machineEvacuations.rosterDigest, operation.rosterDigest),
            eq(machineEvacuations.manifestDigest, operation.manifestDigest)
          )
        )
        .returning()
      if (updated.length !== 1) {
        // A concurrent identical request may have won between our read and
        // CAS. Re-read and recognize only its exact terminating claim; every
        // other transition remains a real lost-CAS failure.
        const winner = await tx.query.machineEvacuations.findFirst({
          where: eq(machineEvacuations.id, operation.id),
        })
        if (
          winner?.state === 'source-terminating' &&
          winner.fencingToken === operation.fencingToken &&
          winner.rosterDigest === operation.rosterDigest &&
          winner.manifestDigest === operation.manifestDigest
        )
          return { providerTerminationRequired: false, reconciliationRequired: true }
        throw new Error('source deletion authorization CAS lost')
      }
    }
    return { providerTerminationRequired: true }
  })
}

export async function settleEvacuationSourceTerminated(operationId: string): Promise<void> {
  const updated = await db
    .update(machineEvacuations)
    .set({ state: 'source-terminated', updatedAt: new Date() })
    .where(and(eq(machineEvacuations.id, operationId), eq(machineEvacuations.state, 'source-terminating')))
    .returning()
  if (updated.length === 1) return
  const existing = await db.query.machineEvacuations.findFirst({ where: eq(machineEvacuations.id, operationId) })
  if (existing?.state === 'source-terminated' || existing?.state === 'source-deleted') return
  throw new Error('evacuation source termination settlement CAS lost')
}

export async function settleEvacuationSourceDeleted(operationId: string): Promise<void> {
  const updated = await db
    .update(machineEvacuations)
    .set({ state: 'source-deleted', updatedAt: new Date() })
    .where(and(eq(machineEvacuations.id, operationId), eq(machineEvacuations.state, 'source-terminated')))
    .returning()
  if (updated.length === 1) return
  const existing = await db.query.machineEvacuations.findFirst({ where: eq(machineEvacuations.id, operationId) })
  if (existing?.state === 'source-deleted') return
  throw new Error('evacuation source deletion settlement CAS lost')
}

export async function failEvacuationSourceRetained(operationId: string): Promise<void> {
  await db
    .update(machineEvacuations)
    .set({ state: 'failed-source-retained', updatedAt: new Date() })
    .where(and(eq(machineEvacuations.id, operationId), sql`${machineEvacuations.state} <> 'source-deleted'`))
}

export async function beginManualBoxEvacuation(input: {
  operationId: string
  sourceMachineId: string
  targetMachineId: string
  sandboxId: string
  unixUser: string
}) {
  const roster = [{ sandboxId: input.sandboxId, unixUser: input.unixUser }]
  const [operation] = await db
    .insert(machineEvacuations)
    .values({
      id: input.operationId,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
      sourceGeneration: null,
      targetGeneration: null,
      rosterDigest: digest(roster),
      fencingToken: randomUUID(),
      state: 'inventoried',
    })
    .returning()
  await db.insert(machineEvacuationBoxes).values({ evacuationId: operation.id, ...roster[0] })
  return operation
}
