import { randomUUID } from 'crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getPrivateArchiveRoot } from '../sandbox/private-archive'
import { parseMigrationManifest, type MigrationManifestV1 } from './migration-manifest'

const SAFE_ID = /^[0-9a-f-]{36}$/i

export function migrationManifestPath(operationId: string, sandboxId: string): string {
  if (!SAFE_ID.test(operationId) || !/^[a-z0-9_-]{1,255}$/i.test(sandboxId))
    throw new Error('invalid migration evidence identity')
  return join(getPrivateArchiveRoot(), 'box-migrations', operationId, `${sandboxId}.manifest.json`)
}

/** Atomically persist and fsync immutable pre-transfer evidence. */
export function persistMigrationManifest(manifest: MigrationManifestV1): string {
  const path = migrationManifestPath(manifest.operationId, manifest.sandboxId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // Unique even across concurrent retries in one process and unaffected by a
  // stale temp left by a process that crashed before publication.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(manifest))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    // link(2) publishes atomically and, unlike rename(2), cannot replace prior
    // evidence. A racing retry may only reuse byte-identical evidence.
    linkSync(temp, path)
  } catch (error) {
    const existing = loadMigrationManifest(manifest.operationId, manifest.sandboxId)
    if (existing.manifestSha256 !== manifest.manifestSha256 || JSON.stringify(existing) !== JSON.stringify(manifest))
      throw new Error('migration evidence is immutable', { cause: error })
  } finally {
    unlinkSync(temp)
  }
  const dirFd = openSync(dirname(path), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
  return path
}

export function loadMigrationManifest(operationId: string, sandboxId: string): MigrationManifestV1 {
  return parseMigrationManifest(JSON.parse(readFileSync(migrationManifestPath(operationId, sandboxId), 'utf8')))
}
