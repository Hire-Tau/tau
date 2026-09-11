export const AGENT_TYPE_COLOR_PALETTE = [
  { className: 'text-violet-700 dark:text-violet-300', lightHex: '#6d28d9', darkHex: '#c4b5fd' },
  { className: 'text-blue-700 dark:text-blue-300', lightHex: '#1d4ed8', darkHex: '#93c5fd' },
  { className: 'text-emerald-700 dark:text-emerald-300', lightHex: '#047857', darkHex: '#6ee7b7' },
  { className: 'text-amber-800 dark:text-amber-300', lightHex: '#92400e', darkHex: '#fcd34d' },
  { className: 'text-rose-700 dark:text-rose-300', lightHex: '#be123c', darkHex: '#fda4af' },
  { className: 'text-cyan-800 dark:text-cyan-300', lightHex: '#155e75', darkHex: '#67e8f9' },
] as const

export function agentTypeColor(agentTypeId: string | null): string {
  if (!agentTypeId) return 'text-muted'
  let hash = 0
  for (const point of agentTypeId) hash = (hash * 31 + point.codePointAt(0)!) >>> 0
  return AGENT_TYPE_COLOR_PALETTE[hash % AGENT_TYPE_COLOR_PALETTE.length].className
}
