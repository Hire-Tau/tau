/** UUID remains the storage key; public links and labels prefer the instance-wide number. */
export function workStreamRef(work: { id: string; number?: number | null }): string {
  return work.number ? String(work.number) : work.id
}
export function workStreamLabel(work: { id: string; number?: number | null }): string {
  return work.number ? `#${work.number}` : work.id.slice(0, 8)
}
export function workStreamTitle(work: { title: string; number?: number | null }): string {
  return work.number ? `#${work.number} · ${work.title}` : work.title
}
