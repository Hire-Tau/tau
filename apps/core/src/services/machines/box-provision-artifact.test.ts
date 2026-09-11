import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BOX_PROVISION_REMOTE_PATH, boxProvisionArtifact, buildBoxProvisionArtifact } from './box-provision-artifact'

const repoRoot = join(import.meta.dir, '../../../../../')
const checkedInBoxProvisionSh = readFileSync(join(repoRoot, 'scripts/machine/box-provision.sh'), 'utf8')

const SENTINEL = '#!/bin/bash\n# SENTINEL-BOX-PROVISION-FROM-ARTIFACT\n'

/**
 * The artifact's bytes and version must come from the SAME prebuilt-preferring
 * resolution the bootstrap version stamp uses ({@link effectiveMachineScripts}),
 * or an artifact deployment pushes the bundle's inlined script over the release's
 * own box-provision.sh — silently reverting it on every ensure.
 */
describe('buildBoxProvisionArtifact', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'box-provision-artifact-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('in a git checkout: pushes the inlined script bytes, versioned sha256(script)', async () => {
    const { files, version } = await buildBoxProvisionArtifact()

    expect(files).toHaveLength(1)
    expect(files[0].remotePath).toBe(BOX_PROVISION_REMOTE_PATH)
    expect(files[0].mode).toBe('0755')
    expect(new TextDecoder().decode(files[0].bytes)).toBe(checkedInBoxProvisionSh)
    expect(version).toBe(createHash('sha256').update(checkedInBoxProvisionSh).digest('hex'))
  })

  it('with an artifact root: pushes the PREBUILT script bytes, versioned sha256(prebuilt)', async () => {
    writeFileSync(join(tmp, 'artifact.json'), '{}')
    mkdirSync(join(tmp, 'machine'), { recursive: true })
    writeFileSync(join(tmp, 'machine', 'bootstrap.sh'), '#!/bin/bash\n# SENTINEL-BOOTSTRAP\n')
    writeFileSync(join(tmp, 'machine', 'box-provision.sh'), SENTINEL)

    const { files, version } = await buildBoxProvisionArtifact({ root: tmp })

    expect(files).toHaveLength(1)
    expect(new TextDecoder().decode(files[0].bytes)).toBe(SENTINEL)
    expect(version).toBe(createHash('sha256').update(SENTINEL).digest('hex'))
    // The bundle's inlined copy must NOT leak into an artifact deployment.
    expect(new TextDecoder().decode(files[0].bytes)).not.toBe(checkedInBoxProvisionSh)
  })

  it('the registry entry delegates to the same builder (default opts)', async () => {
    expect(boxProvisionArtifact.name).toBe('box-provision')
    const viaRegistry = await boxProvisionArtifact.build()
    const viaBuilder = await buildBoxProvisionArtifact()

    expect(viaRegistry.version).toBe(viaBuilder.version)
    expect(new TextDecoder().decode(viaRegistry.files[0].bytes)).toBe(
      new TextDecoder().decode(viaBuilder.files[0].bytes)
    )
  })
})
