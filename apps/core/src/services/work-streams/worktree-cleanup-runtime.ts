import { createHash } from 'node:crypto'
import runner from './worktree-cleanup-runner.sh' with { type: 'text' }
import type { RepositoryExec, WorktreeOwnership } from './repository-setup'

export interface WorktreeRemovalInput {
  ownership: WorktreeOwnership
  head: string
  operationId: string
}
export interface WorktreeRemovalReceipt {
  status: 'succeeded' | 'retained' | 'failed'
  reason: string
  operationId: string
  digest: string
}

/** Caller must durably fence reuse before dispatch. Rejections mean unknown outcome,
 * not permission to release the fence. Replays never repeat a completed removal. */
export async function removeOwnedWorktree(
  exec: RepositoryExec,
  input: WorktreeRemovalInput
): Promise<WorktreeRemovalReceipt> {
  return invoke(exec, input, 'remove')
}

/** Recovery is read-only: a missing receipt never dispatches another deletion. */
export async function readWorktreeRemovalReceipt(
  exec: RepositoryExec,
  input: WorktreeRemovalInput
): Promise<WorktreeRemovalReceipt> {
  return invoke(exec, input, 'probe')
}

async function invoke(
  exec: RepositoryExec,
  input: WorktreeRemovalInput,
  mode: 'remove' | 'probe'
): Promise<WorktreeRemovalReceipt> {
  const serialized = JSON.stringify(input)
  const raw = await exec(['sh', '-c', runner, 'tau-worktree-cleanup', serialized, mode])
  const receipt = JSON.parse(raw) as WorktreeRemovalReceipt
  if (
    !receipt ||
    receipt.operationId !== input.operationId ||
    receipt.digest !== createHash('sha256').update(serialized).digest('hex') ||
    !['succeeded', 'retained', 'failed'].includes(receipt.status) ||
    typeof receipt.reason !== 'string'
  ) {
    throw new Error('Worktree cleanup outcome is unproven; keep the reuse fence')
  }
  return receipt
}
