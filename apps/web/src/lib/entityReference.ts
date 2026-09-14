export type EntityReference = { kind: 'ws' | 'agent'; id: string }

/** Only canonical UUIDs and their prefixes; resolution must reject ambiguous IDs. */
export function parseEntityReference(value: string | undefined): EntityReference | null {
  const match = value?.match(/^tau:(ws|agent):([0-9a-f-]{1,36})$/i)
  if (!match) return null
  const id = match[2]!.toLowerCase()
  const template = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  if ([...id].some((char, index) => (template[index] === '-' ? char !== '-' : !/[0-9a-f]/.test(char)))) return null
  return { kind: match[1]!.toLowerCase() as EntityReference['kind'], id }
}
