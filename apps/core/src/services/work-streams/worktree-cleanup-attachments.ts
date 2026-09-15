import path from 'node:path'
import type { RepositoryExec } from './repository-setup'

export type AttachmentPaths = Partial<Record<'worktree' | 'repository', string>>
export interface ResolvedWorktreeAttachment {
  id: string
  raw: AttachmentPaths
  canonical: AttachmentPaths
}

export function worktreeAttachmentPaths(metadata: unknown): AttachmentPaths {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw Error('Unrecognized registered attachment metadata')
  const candidate = (metadata as Record<string, unknown>).git
  if (candidate != null && (typeof candidate !== 'object' || Array.isArray(candidate)))
    throw Error('Unrecognized registered Git attachment metadata')
  const git = candidate as Record<string, unknown> | null | undefined
  return Object.fromEntries(
    ['worktree', 'repository'].filter((key) => typeof git?.[key] === 'string').map((key) => [key, git![key]])
  )
}

const resolvePaths = `
const fs = require('node:fs'), path = require('node:path');
const { workspace, paths } = JSON.parse(process.argv[1]);
const canonical = (value) => {
  let existing = path.resolve(workspace, value);
  const missing = [];
  for (;;) {
    try { fs.lstatSync(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing)); existing = path.dirname(existing);
    }
  }
  // lstat deliberately distinguishes a dangling symlink from a missing suffix.
  return path.join(fs.realpathSync(existing), ...missing);
};
console.log(JSON.stringify(paths.map((entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, canonical(value)])))));
`

/** Read-only identity observation, never mkdir or repair. Call outside database
 * locks and compare raw bindings again in the final lifecycle transaction. */
export async function resolveWorktreeAttachments(
  exec: RepositoryExec,
  workspace: string,
  streams: Array<{ id: string; metadata: unknown }>
): Promise<ResolvedWorktreeAttachment[]> {
  const result = streams.map(({ id, metadata }) => ({
    id,
    raw: worktreeAttachmentPaths(metadata),
    canonical: {} as AttachmentPaths,
  }))
  const bound = result.filter((entry) => Object.keys(entry.raw).length)
  // Bound argument size and avoid one remote process per registered stream.
  for (let offset = 0; offset < bound.length; offset += 8) {
    const batch = bound.slice(offset, offset + 8)
    if (batch.some((entry) => Object.values(entry.raw).some((value) => value.length > 4096)))
      throw Error('Unresolvable attachment path')
    const resolved: unknown = JSON.parse(
      await exec(['bun', '-e', resolvePaths, JSON.stringify({ workspace, paths: batch.map((entry) => entry.raw) })])
    )
    if (!Array.isArray(resolved) || resolved.length !== batch.length) throw Error('Unproven attachment identities')
    for (const [index, entry] of batch.entries()) {
      const canonical = resolved[index]
      if (
        !canonical ||
        Object.keys(entry.raw).some((key) => typeof canonical[key] !== 'string' || !path.isAbsolute(canonical[key]))
      )
        throw Error('Unproven attachment identity')
      entry.canonical = canonical
    }
  }
  return result
}
