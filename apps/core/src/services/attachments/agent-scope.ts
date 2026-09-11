import { Agent } from '../../entities/Agent'

export class InvalidAttachmentError extends Error {
  constructor() {
    super('INVALID_ATTACHMENT')
    this.name = 'InvalidAttachmentError'
  }
}

export interface AttachmentScope {
  sandboxId: string
  ownerAgentIds: string[]
}

export async function resolveAttachmentScope(target: Agent): Promise<AttachmentScope> {
  try {
    const sandboxId = await target.getSandboxId()
    const ownerAgentIds: string[] = []
    const seen = new Set<string>()
    let current: Agent | null = target

    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      if ((await current.getSandboxId()) !== sandboxId) break
      ownerAgentIds.push(current.id)
      if (!current.parentAgentId) break
      current = await Agent.find(current.parentAgentId)
      if (!current) throw new InvalidAttachmentError()
    }
    return { sandboxId, ownerAgentIds }
  } catch (error) {
    if (error instanceof InvalidAttachmentError) throw error
    throw new InvalidAttachmentError()
  }
}

export function assertAttachmentInScope(record: { agentId: string; sandboxId: string }, scope: AttachmentScope): void {
  if (record.sandboxId !== scope.sandboxId || !scope.ownerAgentIds.includes(record.agentId)) {
    throw new InvalidAttachmentError()
  }
}
