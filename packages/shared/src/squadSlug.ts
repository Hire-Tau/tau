/**
 * Derive a URL-friendly slug from a free-text name.
 * Lowercase, runs of non-alphanumerics collapse to a single hyphen,
 * leading/trailing hyphens stripped. Returns '' when the name has no
 * alphanumerics — callers substitute a stable id in that case.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface SlugSquadInput {
  id: string
  name: string
  createdAt: string | Date | number
}

export interface SquadSlugMap {
  idToSlug: Record<string, string>
  slugToId: Record<string, string>
}

/**
 * Build a bijective id<->slug map over the given squads. Slugs are derived
 * on the fly from each name; collisions are disambiguated with -2, -3, … in a
 * deterministic order (createdAt asc, then id asc) so the same input set always
 * produces the same assignment regardless of array order.
 */
export function squadSlugMap(squads: readonly SlugSquadInput[]): SquadSlugMap {
  const ordered = [...squads].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime()
    const tb = new Date(b.createdAt).getTime()
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const idToSlug: Record<string, string> = {}
  const slugToId: Record<string, string> = {}

  for (const squad of ordered) {
    const base = slugify(squad.name) || squad.id
    let candidate = base
    let n = 2
    while (slugToId[candidate] !== undefined) {
      candidate = `${base}-${n}`
      n++
    }
    idToSlug[squad.id] = candidate
    slugToId[candidate] = squad.id
  }

  return { idToSlug, slugToId }
}
