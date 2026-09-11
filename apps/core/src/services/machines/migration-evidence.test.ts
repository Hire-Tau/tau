import { expect, it } from 'bun:test'
import { chmodSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createMigrationManifest } from './migration-manifest'
import { loadMigrationManifest, migrationManifestPath, persistMigrationManifest } from './migration-evidence'

it('atomically persists and reloads operation-bound manifest evidence', async () => {
  const operationId = crypto.randomUUID()
  const sandboxId = `agent_${crypto.randomUUID()}`
  const manifest = createMigrationManifest(
    {
      operationId,
      sandboxId,
      source: { machineId: 'source', generation: null, unixUser: 'box_aaaaaaaaaaaa' },
      target: { machineId: 'target', generation: null, unixUser: 'box_aaaaaaaaaaaa' },
    },
    [
      { name: 'workspace', presence: 'present', mode: '755', owner: 'box-user', entries: [] },
      { name: '.private', presence: 'absent', entries: [] },
    ]
  )
  const path = persistMigrationManifest(manifest)
  try {
    expect(path).toBe(migrationManifestPath(operationId, sandboxId))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadMigrationManifest(operationId, sandboxId)).toEqual(manifest)
    expect(persistMigrationManifest(manifest)).toBe(path)
    const crashResidue = `${path}.${process.pid}.tmp`
    writeFileSync(crashResidue, 'partial')
    expect(persistMigrationManifest(manifest)).toBe(path)
    expect(await Promise.all(Array.from({ length: 8 }, async () => persistMigrationManifest(manifest)))).toEqual(
      Array(8).fill(path)
    )
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([
      crashResidue.split('/').at(-1)!,
    ])
    const changed = createMigrationManifest({ ...manifest, source: manifest.source, target: manifest.target }, [
      {
        name: 'workspace',
        presence: 'present',
        mode: '755',
        owner: 'box-user',
        entries: [
          {
            pathB64: Buffer.from('changed').toString('base64'),
            type: 'file',
            mode: '600',
            size: '1',
            contentSha256: '0'.repeat(64),
          },
        ],
      },
      { name: '.private', presence: 'absent', entries: [] },
    ])
    expect(() => persistMigrationManifest(changed)).toThrow(/immutable/)
    expect(loadMigrationManifest(operationId, sandboxId)).toEqual(manifest)
    chmodSync(path, 0o600)
    const corrupt = JSON.parse(readFileSync(path, 'utf8'))
    corrupt.manifestSha256 = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(corrupt))
    expect(() => loadMigrationManifest(operationId, sandboxId)).toThrow(/digest/i)
  } finally {
    rmSync(dirname(path), { recursive: true, force: true })
  }
})
