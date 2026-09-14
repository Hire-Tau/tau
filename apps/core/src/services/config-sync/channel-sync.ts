import { parse, stringify } from 'yaml'
import { channelInstances } from '../../db'
import { getProvider } from '../../channels'
import type { ChannelInstanceYaml, ProviderConfig } from '../../channels/provider'
import { CHANNELS_DIR } from '../../lib/paths'
import { parseTrustedChannelIds, parseChannelIds } from '../channel-access'
import { ConfigSync } from './ConfigSync'

interface ParsedChannel {
  id: string
  name: string
  provider: string
  providerConfig: ProviderConfig
  trustedChannelIds: string[]
  allowedChannelIds: string[]
  deniedChannelIds: string[]
  channelSquadMap: Record<string, string>
  defaultSquadId: string | null
}

export class ChannelSync extends ConfigSync<ParsedChannel> {
  readonly name = 'channels'
  readonly directory = CHANNELS_DIR
  readonly table = channelInstances
  readonly idColumn = channelInstances.id
  readonly yamlTemplateColumn = channelInstances.yamlTemplate
  readonly yamlFieldOverridesColumn = channelInstances.yamlFieldOverrides
  readonly updatedAtColumn = channelInstances.updatedAt
  readonly disabledColumn = channelInstances.disabled

  parse(content: string, filename: string): ParsedChannel {
    const config = parse(content) as ChannelInstanceYaml

    if (!config.id || !config.name || !config.provider) {
      throw new Error(`${filename}: missing required fields (id, name, provider)`)
    }

    const provider = getProvider(config.provider)
    if (!provider) {
      throw new Error(`${filename}: unknown provider '${config.provider}'`)
    }

    const validationError = provider.validateConfig(config)
    if (validationError) {
      throw new Error(`${filename}: ${validationError}`)
    }

    if (!config.defaultSquadId) {
      throw new Error(`${filename}: channel instance requires defaultSquadId for unmapped channels`)
    }

    return {
      id: config.id,
      name: config.name,
      provider: config.provider,
      providerConfig: config.providerConfig || {},
      trustedChannelIds: parseTrustedChannelIds(config.trustedChannelIds ?? []),
      allowedChannelIds: parseChannelIds(config.allowedChannelIds ?? []),
      deniedChannelIds: parseChannelIds(config.deniedChannelIds ?? []),
      channelSquadMap: config.channelSquadMap || {},
      defaultSquadId: config.defaultSquadId,
    }
  }

  getId(parsed: ParsedChannel): string {
    return parsed.id
  }

  toRecord(parsed: ParsedChannel): Record<string, unknown> {
    return {
      id: parsed.id,
      name: parsed.name,
      provider: parsed.provider,
      providerConfig: parsed.providerConfig,
      trustedChannelIds: parsed.trustedChannelIds,
      allowedChannelIds: parsed.allowedChannelIds,
      deniedChannelIds: parsed.deniedChannelIds,
      channelSquadMap: parsed.channelSquadMap,
      defaultSquadId: parsed.defaultSquadId,
    }
  }

  toComparable(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id as string,
      name: row.name as string,
      provider: row.provider as string,
      providerConfig: (row.providerConfig as ProviderConfig) || {},
      trustedChannelIds: row.trustedChannelIds ?? [],
      allowedChannelIds: row.allowedChannelIds ?? [],
      deniedChannelIds: row.deniedChannelIds ?? [],
      channelSquadMap: (row.channelSquadMap as Record<string, string>) || {},
      defaultSquadId: (row.defaultSquadId as string) || null,
    }
  }

  toYaml(row: Record<string, unknown>): string {
    const obj: Record<string, unknown> = {
      id: row.id,
      name: row.name,
      provider: row.provider,
    }
    if (row.providerConfig && Object.keys(row.providerConfig as object).length > 0) {
      obj.providerConfig = row.providerConfig
    }
    if (Array.isArray(row.trustedChannelIds) && row.trustedChannelIds.length)
      obj.trustedChannelIds = row.trustedChannelIds
    for (const key of ['allowedChannelIds', 'deniedChannelIds'] as const) {
      if (Array.isArray(row[key]) && row[key].length) obj[key] = row[key]
    }
    const channelSquadMap = row.channelSquadMap as Record<string, string> | null
    if (channelSquadMap && Object.keys(channelSquadMap).length > 0) obj.channelSquadMap = channelSquadMap
    if (row.defaultSquadId) obj.defaultSquadId = row.defaultSquadId

    return stringify(obj, { lineWidth: 120 })
  }

  // Channel conversations are created on demand after sender authorization.
}
