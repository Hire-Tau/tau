export function toolNameMatchesPattern(pattern: string, name: string): boolean {
  const lowerPattern = pattern.toLowerCase()
  const lowerName = name.toLowerCase()
  if (!lowerPattern.includes('*')) return lowerPattern === lowerName
  const regex = new RegExp(
    '^' + lowerPattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : '\\' + c)) + '$'
  )
  return regex.test(lowerName)
}

export function toolNameMatchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => toolNameMatchesPattern(p, name))
}

/** Applies an agent type's tool policy, with deny patterns taking precedence. */
export function filterToolsByPolicy<T extends { name: string }>(
  tools: T[],
  allow?: string[] | null,
  deny?: string[] | null
): T[] {
  return tools.filter(
    (tool) => (!allow || toolNameMatchesAny(allow, tool.name)) && (!deny || !toolNameMatchesAny(deny, tool.name))
  )
}
