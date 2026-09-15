import type { CodeHostingRegistry } from '../integrations/code-hosting/registry'
import { codeHostFromRemote, type RepositoryExec } from './repository-setup'

export class WorktreeDeliveryUnprovenError extends Error {}

/** Revalidate live delivery and recovery of the exact head captured at finish.
 * PR refs preserve squash-merged feature commits without requiring ancestry. */
export async function verifyWorktreeCleanupDelivery(
  input: {
    metadata: Record<string, unknown>
    mode: string
    deliveredHead: string | null
    repository: string
    squadId: string
  },
  exec: RepositoryExec,
  registry: CodeHostingRegistry
): Promise<string> {
  function refuse(reason: string): never {
    throw new WorktreeDeliveryUnprovenError(reason)
  }
  const head = input.deliveredHead
  if (!head || !/^[a-f0-9]{40}$/.test(head)) refuse('No authoritative delivered head was captured; retain the worktree')
  const binding = registry.resolve(input.metadata)
  if (!binding || !['pr-merge', 'pr-auto-merge', 'direct-merge'].includes(input.mode))
    refuse('Cleanup requires independently verified code-host delivery')
  const { reference, adapter } = binding!
  const git = input.metadata.git as Record<string, unknown> | undefined
  const remote = git?.remote ?? 'origin'
  if (typeof remote !== 'string' || !/^[\w][\w.-]*$/.test(remote)) refuse('Git remote selection is invalid')
  for (const args of [
    ['remote', 'get-url', remote],
    ['remote', 'get-url', '--push', '--all', remote],
  ]) {
    const urls = (await exec(['git', '-C', input.repository, ...args])).trim().split('\n')
    const identity = urls.length === 1 ? codeHostFromRemote(urls[0]!) : undefined
    if (
      !identity ||
      identity.integration !== reference.integration ||
      identity.repository.toLowerCase() !== reference.repository.toLowerCase()
    )
      refuse('Git remote does not match the delivered code-host repository')
  }
  const base = git?.baseBranch
  if (typeof base !== 'string' || !base || typeof git?.branch !== 'string')
    refuse('Delivery branch bindings are incomplete')
  let ref: string
  if (input.mode === 'direct-merge') {
    ref = `refs/heads/${base}`
  } else {
    if (!reference.changeRequest) refuse('Delivery change request is missing')
    const change = await adapter.changeRequest(reference, input.squadId)
    if (!change?.merged || change.headSha !== head || change.headBranch !== git!.branch || change.baseBranch !== base)
      refuse('Merged change request no longer proves this exact delivered head')
    ref = `refs/pull/${reference.changeRequest!.number}/head`
  }
  const advertised = (await exec(['git', '-C', input.repository, 'ls-remote', '--', remote, ref])).trim().split('\n')
  const [remoteHead, remoteRef] = advertised[0]!.split('\t')
  if (advertised.length !== 1 || remoteRef !== ref || !remoteHead || !/^[a-f0-9]{40}$/.test(remoteHead))
    refuse('Exact remote recovery reference is unavailable')
  if (input.mode === 'direct-merge') {
    // Verify containment in the immutable advertised commit, not a moving base.
    if (!(await adapter.containsCommit(reference, input.squadId, remoteHead!, head!)))
      refuse('Remote base does not retain the delivered commit')
  } else if (remoteHead !== head) refuse('Remote recovery head differs from delivered head')
  return head!
}
