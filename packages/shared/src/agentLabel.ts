/**
 * How an agent is identified in the UI.
 *
 * An agent has a short, stable, unique-per-squad NAME (the "who") and a self-set PURPOSE (the
 * "what"). For humans the purpose leads; the name is the secondary handle that also appears in
 * inbox messages and in how agents refer to each other. Render them together so the two identity
 * systems line up instead of competing.
 */
export interface AgentLabelParts {
  /** Shown prominently: the purpose if set, else the name, else a type fallback. */
  primary: string
  /** Shown alongside `primary`: the name, but only when the purpose is what's leading. */
  secondary?: string
}

export interface AgentLabelInput {
  name?: string | null
  purpose?: string | null
  agentTypeId?: string | null
  /** Used when neither purpose nor name is set. Defaults to agentTypeId, then "Agent". */
  fallback?: string
}

export function agentLabelParts(input: AgentLabelInput): AgentLabelParts {
  const name = input.name?.trim() || undefined
  const purpose = input.purpose?.trim() || undefined
  const fallback = input.fallback?.trim() || input.agentTypeId?.trim() || 'Agent'

  if (purpose) {
    // Purpose leads; keep the name as the secondary handle (unless it's redundant with the purpose).
    return { primary: purpose, secondary: name && name !== purpose ? name : undefined }
  }
  return { primary: name ?? fallback }
}

/** One-line "Purpose · Name" form for compact, single-line spots. */
export function formatAgentLabel(input: AgentLabelInput): string {
  const { primary, secondary } = agentLabelParts(input)
  return secondary ? `${primary} · ${secondary}` : primary
}
