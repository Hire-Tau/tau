import { constants } from 'fs'
import { access, mkdir, rmdir, stat } from 'fs/promises'
import { dirname, resolve } from 'path'

export class HostWorkspacePathError extends Error {}

export interface PreparedHostWorkspacePath {
  path: string
  /** Directories created by this request, ordered parent-first. */
  createdDirectories: string[]
}

export function normalizeHostWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath)
}

/** Remove only directories this request created, stopping when one is no longer empty. */
export async function cleanupPreparedHostWorkspacePath(prepared: PreparedHostWorkspacePath): Promise<void> {
  for (const directory of [...prepared.createdDirectories].reverse()) {
    try {
      await rmdir(directory)
    } catch {
      break
    }
  }
}

/** Ensure a requested host workspace exists and can be used as a working directory. */
export async function ensureHostWorkspacePath(workspacePath: string): Promise<PreparedHostWorkspacePath> {
  const normalizedPath = normalizeHostWorkspacePath(workspacePath)
  const missingDirectories: string[] = []
  const createdDirectories: string[] = []
  let cursor = normalizedPath

  try {
    while (true) {
      try {
        const entry = await stat(cursor)
        if (!entry.isDirectory()) throw new HostWorkspacePathError('Host workspace path is not a directory')
        break
      } catch (error) {
        if (error instanceof HostWorkspacePathError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missingDirectories.push(cursor)
        const parent = dirname(cursor)
        if (parent === cursor) throw error
        cursor = parent
      }
    }

    for (const directory of missingDirectories.reverse()) {
      try {
        await mkdir(directory)
        createdDirectories.push(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }

    const entry = await stat(normalizedPath)
    if (!entry.isDirectory()) throw new HostWorkspacePathError('Host workspace path is not a directory')
    await access(normalizedPath, constants.R_OK | constants.W_OK | constants.X_OK)
    return { path: normalizedPath, createdDirectories }
  } catch (error) {
    await cleanupPreparedHostWorkspacePath({ path: normalizedPath, createdDirectories })
    if (error instanceof HostWorkspacePathError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new HostWorkspacePathError(`Host workspace directory cannot be created or accessed: ${detail}`)
  }
}
