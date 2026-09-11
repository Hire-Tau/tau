import { createHash } from 'node:crypto'

export const CLA_ACTION_COMMIT = '8d334b53875b8eeef6e65611d60aad8f8a7802d4'
export const CLA_ACTION_SHA256 = '63f838d4dfa6e09f362a424305dddf1b407ebe4a08d9a4793ef50d15b86c3116'
const original = 'repository: parsed.registry.repository,'
const replacement = 'repository: process.env.CLA_REGISTRY_OWNER + "/" + process.env.CLA_REGISTRY_REPOSITORY,'

// v0.0.10 reads configuration through the GitHub API, so editing a local YAML
// copy cannot configure it. Adapt only the registry address in the pinned bundle.
// Agreement parsing, contributor matching, signature storage and checks remain
// upstream behavior. A changed upstream bundle must be reviewed explicitly.
export function prepareClaAction(source: string, owner: string, repository: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('CLA registry configuration is missing or invalid')
  }
  if (createHash('sha256').update(source).digest('hex') !== CLA_ACTION_SHA256) {
    throw new Error('CLA action bundle does not match the reviewed version')
  }
  if (source.split(original).length !== 2) throw new Error('CLA registry adapter target is ambiguous')
  return source.replace(original, replacement)
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('Pass the pinned CLA action bundle path')
  const source = await Bun.file(path).text()
  await Bun.write(
    path,
    prepareClaAction(source, process.env.CLA_REGISTRY_OWNER ?? '', process.env.CLA_REGISTRY_REPOSITORY ?? '')
  )
}
