import { SharedPrompt } from '../../entities/SharedPrompt'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('agent-types')

/**
 * `${agentType.id}:${sharedPromptId}` pairs already reported as unknown.
 * Composition runs on every turn, so a stale id would otherwise repeat its
 * warning forever; the operator needs the news once per process.
 */
const warnedUnknownIncludes = new Set<string>()

/** Test helper: forget which unknown ids have already been reported. */
export function resetUnknownSharedPromptWarnings(): void {
  warnedUnknownIncludes.clear()
}

/**
 * The system prompt an agent of this type actually receives before runtime
 * sections: the type's own prompt followed by each enabled include, in list
 * order, joined by blank lines. This is the exact join config-sync used to
 * bake includes in, so resolved prompts are unchanged by the split.
 */
export async function composeAgentTypePrompt(agentType: {
  id: string
  systemPrompt: string
  includes?: string[] | null
}): Promise<string> {
  const ids = agentType.includes ?? []
  if (ids.length === 0) return agentType.systemPrompt
  const found = await SharedPrompt.findMany(ids)
  const parts: string[] = [agentType.systemPrompt]
  for (const id of ids) {
    const include = found.get(id)
    if (!include) {
      const key = `${agentType.id}:${id}`
      if (!warnedUnknownIncludes.has(key)) {
        warnedUnknownIncludes.add(key)
        log.warn(`agent type '${agentType.id}' lists unknown shared prompt '${id}'; skipping`)
      }
      continue
    }
    if (include.disabled) continue
    parts.push(include.content)
  }
  return parts.join('\n\n')
}
