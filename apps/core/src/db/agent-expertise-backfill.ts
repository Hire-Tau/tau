import { createHash } from 'node:crypto'
import type postgres from 'postgres'

/** Frozen migration transform, not a runtime compatibility path. */
export function mergeRetiredFlowPrompt(value: Record<string, unknown>): Record<string, unknown> {
  const { flowPrompt, ...profile } = value
  if (typeof flowPrompt !== 'string' || !flowPrompt.trim()) return profile
  const systemPrompt = typeof profile.systemPrompt === 'string' ? profile.systemPrompt : ''
  const expertise = flowPrompt.trim()
  return {
    ...profile,
    systemPrompt: systemPrompt.includes(expertise)
      ? systemPrompt
      : [systemPrompt, expertise].filter(Boolean).join('\n\n'),
  }
}

// Matches the profile fingerprint used by bindings when this migration shipped.
// Preserve session reuse when folding the retired field into a pinned profile.
export function profileFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`
    if (entry !== null && typeof entry === 'object') {
      return `{${Object.entries(entry)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`
    }
    return JSON.stringify(entry) ?? 'null'
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/** Runs inside the same transaction as the generated DROP COLUMN migration. */
export async function preserveAgentExpertise(connection: postgres.ReservedSql): Promise<void> {
  const types = await connection<
    {
      id: string
      system_prompt: string
      flow_prompt: string | null
      yaml_template: Record<string, unknown> | null
      yaml_field_overrides: string[]
    }[]
  >`
    SELECT id, system_prompt, flow_prompt, yaml_template, yaml_field_overrides FROM agent_types FOR UPDATE`
  // Bind JSON as text before casting: startup uses a Drizzle-wrapped client
  // with pass-through JSON serializers; the standalone migrator uses raw postgres.js.
  for (const row of types) {
    const merged = mergeRetiredFlowPrompt({ systemPrompt: row.system_prompt, flowPrompt: row.flow_prompt })
    const template = row.yaml_template ? mergeRetiredFlowPrompt(row.yaml_template) : null
    const overrides = new Set(row.yaml_field_overrides.filter((key) => key !== 'flowPrompt'))
    if (row.flow_prompt?.trim()) overrides.add('systemPrompt')
    await connection`UPDATE agent_types SET system_prompt = ${merged.systemPrompt as string},
      yaml_template = ${template === null ? null : JSON.stringify(template)}::text::jsonb, yaml_field_overrides = ${JSON.stringify([...overrides])}::text::jsonb
      WHERE id = ${row.id}`
  }

  // Existing runs retain their own expertise, not the latest catalog prompt.
  // Stream batches keep memory bounded on instances with a long history.
  let cursor = ''
  while (true) {
    const runs = await connection<{ work_stream_id: string; profiles: Record<string, Record<string, unknown>> }[]>`
      SELECT work_stream_id, profiles FROM work_stream_flow_runs
      WHERE work_stream_id::text > ${cursor}
      ORDER BY work_stream_id LIMIT 250 FOR UPDATE`
    if (!runs.length) break
    for (const row of runs) {
      const profiles = Object.fromEntries(
        Object.entries(row.profiles).map(([key, value]) => [key, mergeRetiredFlowPrompt(value)])
      )
      await connection`UPDATE work_stream_flow_runs SET profiles = ${JSON.stringify(profiles)}::text::jsonb WHERE work_stream_id = ${row.work_stream_id}`
    }
    cursor = runs[runs.length - 1]!.work_stream_id
  }

  cursor = ''
  while (true) {
    const bindings = await connection<{ agent_id: string; binding_key: string; profile: Record<string, unknown> }[]>`
      SELECT agent_id, binding_key, profile FROM work_style_bindings
      WHERE agent_id::text > ${cursor} ORDER BY agent_id LIMIT 250 FOR UPDATE`
    if (!bindings.length) break
    for (const row of bindings) {
      const profile = mergeRetiredFlowPrompt(row.profile)
      const key = row.binding_key.replace(`:${profileFingerprint(row.profile)}:`, `:${profileFingerprint(profile)}:`)
      await connection`UPDATE work_style_bindings SET profile = ${JSON.stringify(profile)}::text::jsonb, binding_key = ${key} WHERE agent_id = ${row.agent_id}`
    }
    cursor = bindings[bindings.length - 1]!.agent_id
  }
}
