export interface NotionConnectionConfiguration {
  version: 1
  workspaceId: string
  workspaceName: string | null
  workspaceIcon: string | null
  botId: string
}

const CONFIG_KEYS = ['botId', 'version', 'workspaceIcon', 'workspaceId', 'workspaceName']

export function parseNotionConfiguration(value: unknown): NotionConnectionConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Notion configuration')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join() !== CONFIG_KEYS.join()) throw new Error('Invalid Notion configuration')
  if (
    row.version !== 1 ||
    !boundedString(row.workspaceId, 256) ||
    !nullableString(row.workspaceName, 512) ||
    !nullableHttpsUrl(row.workspaceIcon) ||
    !boundedString(row.botId, 256)
  ) {
    throw new Error('Invalid Notion configuration')
  }
  return {
    version: 1,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName as string | null,
    workspaceIcon: row.workspaceIcon as string | null,
    botId: row.botId,
  }
}

export function safeNotionConfiguration(configuration: NotionConnectionConfiguration): {
  workspaceId: string
  workspaceName: string | null
  workspaceIcon: string | null
} {
  return {
    workspaceId: configuration.workspaceId,
    workspaceName: configuration.workspaceName,
    workspaceIcon: configuration.workspaceIcon,
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function nullableString(value: unknown, max: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= max)
}

function nullableHttpsUrl(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.toString() === value
  } catch {
    return false
  }
}
