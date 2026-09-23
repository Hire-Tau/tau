export interface SlackConnectionConfiguration {
  version: 1
  teamId: string
  teamName: string | null
  botUserId: string
  appId: string
}

const CONFIG_KEYS = ['appId', 'botUserId', 'teamId', 'teamName', 'version']

export function parseSlackConfiguration(value: unknown): SlackConnectionConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Slack configuration')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join() !== CONFIG_KEYS.join()) throw new Error('Invalid Slack configuration')
  if (
    row.version !== 1 ||
    !boundedString(row.teamId, 256) ||
    !nullableString(row.teamName, 512) ||
    !boundedString(row.botUserId, 256) ||
    !boundedString(row.appId, 256)
  ) {
    throw new Error('Invalid Slack configuration')
  }
  return {
    version: 1,
    teamId: row.teamId,
    teamName: row.teamName as string | null,
    botUserId: row.botUserId,
    appId: row.appId,
  }
}

export function safeSlackConfiguration(configuration: SlackConnectionConfiguration): {
  teamId: string
  teamName: string | null
} {
  return {
    teamId: configuration.teamId,
    teamName: configuration.teamName,
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function nullableString(value: unknown, max: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= max)
}
