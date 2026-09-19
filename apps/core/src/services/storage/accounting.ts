import type { StorageFolder, StorageSquad } from '@tau/shared'

export interface StorageOwner {
  home: string
  squadId: string
  squadName: string
  label: string
}

/** GNU du's NUL output preserves spaces, tabs and newlines in directory names.
 * Do not follow symlinks or add descendants to their already inclusive parents.
 */
export function parseDirectoryUsage(output: string): Map<string, number> {
  const entries = new Map<string, number>()
  for (const record of output.split('\0')) {
    const match = /^(\d+)\t(\/home(?:\/[^\0]*)?)$/.exec(record)
    if (!match) continue
    const bytes = Number(match[1])
    const path = match[2]
    if (!Number.isSafeInteger(bytes) || path.split('/').some((part) => part === '.' || part === '..')) continue
    entries.set(path, bytes)
  }
  return entries
}

export function attributeStorage(entries: Map<string, number>, owners: StorageOwner[]): StorageSquad[] {
  const squads = new Map<string, StorageSquad>()
  const claimedHomes = new Set<string>()
  const children = new Map<string, string[]>()
  for (const path of entries.keys()) {
    const parent = path.slice(0, path.lastIndexOf('/'))
    children.set(parent, [...(children.get(parent) ?? []), path])
  }
  const folder = (path: string, name = path.slice(path.lastIndexOf('/') + 1)): StorageFolder => ({
    name,
    bytes: entries.get(path)!,
    children: (children.get(path) ?? []).map((child) => folder(child)).sort((a, b) => b.bytes - a.bytes),
  })
  for (const owner of owners) {
    const bytes = entries.get(owner.home)
    if (bytes === undefined || claimedHomes.has(owner.home)) continue
    claimedHomes.add(owner.home)
    const squad = squads.get(owner.squadId) ?? {
      id: owner.squadId,
      name: owner.squadName,
      bytes: 0,
      folders: [],
    }
    squad.bytes += bytes
    squad.folders.push(folder(owner.home, owner.label))
    squads.set(squad.id, squad)
  }
  return [...squads.values()]
    .map((squad) => ({
      ...squad,
      folders: squad.folders.sort((a, b) => b.bytes - a.bytes),
    }))
    .sort((a, b) => b.bytes - a.bytes)
}
