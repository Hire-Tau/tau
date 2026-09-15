import { inArray } from 'drizzle-orm'
import type { SquadActivityItem } from '@tau/shared'
import { db, workStreams } from '../../db'

/** Enrich only an already-authorized page; historical projection rows keep their storage keys. */
export async function addWorkReferences<T extends SquadActivityItem>(items: T[]): Promise<T[]> {
  const ids = [...new Set(items.flatMap((item) => (item.ref.type === 'workstream' ? [item.ref.workStreamId] : [])))]
  if (!ids.length) return items
  const rows = await db
    .select({ id: workStreams.id, number: workStreams.number })
    .from(workStreams)
    .where(inArray(workStreams.id, ids))
  const numbers = new Map(rows.map((row) => [row.id, row.number]))
  return items.map((item) => {
    if (item.ref.type !== 'workstream') return item
    const number = numbers.get(item.ref.workStreamId)
    if (!number) return item
    return {
      ...item,
      ref: { ...item.ref, workStreamNumber: number },
      summary: item.summary.replace(/^\[ws-[0-9a-f]+ /, `[#${number} `),
    }
  })
}
