/**
 * Host workspace directory management.
 *
 * Creates, removes, and validates workspace directories on the host filesystem.
 * Runtime-agnostic — used by Docker (bind mounts) and referenced for path
 * resolution. K8s workspaces live on PVCs but may still use these for
 * host-side bookkeeping.
 */

import { mkdirSync, rmSync, existsSync, realpathSync } from 'fs'
import { join, isAbsolute, resolve, normalize, dirname, basename, sep } from 'path'
import { getHomeDir } from '../../lib/utils/home'

export function getWorkspacePath(workspaceId: string): string {
  return join(getHomeDir(), 'workspaces', workspaceId)
}

/**
 * Create the workspace directory. Returns the absolute path.
 * Safe to call multiple times — no-ops if already exists.
 */
export function ensureWorkspace(workspaceId: string): string {
  const dir = getWorkspacePath(workspaceId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Remove the workspace directory.
 * Safe to call even if the directory doesn't exist.
 */
export function removeWorkspace(workspaceId: string): void {
  const dir = getWorkspacePath(workspaceId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Validates that a path is within the allowed workspace directory.
 * Resolves symlinks to prevent escape attempts.
 */
export function validateWorkspacePath(targetPath: string, workspacePath: string): void {
  const absolutePath = isAbsolute(targetPath) ? targetPath : resolve(workspacePath, targetPath)

  let resolvedPath: string
  if (existsSync(absolutePath)) {
    resolvedPath = realpathSync(absolutePath)
  } else {
    const parentDir = dirname(absolutePath)
    if (existsSync(parentDir)) {
      const resolvedParent = realpathSync(parentDir)
      resolvedPath = resolve(resolvedParent, basename(absolutePath))
    } else {
      resolvedPath = absolutePath
    }
  }

  const resolvedWorkspace = realpathSync(workspacePath)
  const normalizedPath = normalize(resolvedPath)
  const normalizedWorkspace = normalize(resolvedWorkspace)

  if (normalizedPath !== normalizedWorkspace && !normalizedPath.startsWith(normalizedWorkspace + sep)) {
    throw new Error(`Access denied: ${targetPath} is outside workspace`)
  }
}
