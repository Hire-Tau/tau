export const AGENT_TYPE_COLOR_PALETTE = [
  { className: 'text-agent-type-1', token: '--agent-type-1-fg' },
  { className: 'text-agent-type-2', token: '--agent-type-2-fg' },
  { className: 'text-agent-type-3', token: '--agent-type-3-fg' },
  { className: 'text-agent-type-4', token: '--agent-type-4-fg' },
  { className: 'text-agent-type-5', token: '--agent-type-5-fg' },
  { className: 'text-agent-type-6', token: '--agent-type-6-fg' },
] as const

export function agentTypeColor(agentTypeId: string | null): string {
  if (!agentTypeId) return 'text-muted'
  let hash = 0
  for (const point of agentTypeId) hash = (hash * 31 + point.codePointAt(0)!) >>> 0
  return AGENT_TYPE_COLOR_PALETTE[hash % AGENT_TYPE_COLOR_PALETTE.length].className
}
