/**
 * Tau slash command names shared across channel providers (Discord, Slack, Telegram).
 */

/** All known slash command subcommands. Used for parsing user input. */
export const TAU_SLASH_COMMANDS = ['status', 'help', 'ask', 'link', 'notify', 'unnotify'] as const

/**
 * Discord option names for extracting content from slash command subcommands.
 * Used by extractOptionValue — tries each name in order (ask uses 'message', notify/unnotify use 'squad').
 */
export const TAU_DISCORD_OPTION_NAMES = ['message', 'squad', 'code'] as const

export type TauSlashCommand = (typeof TAU_SLASH_COMMANDS)[number]

/** Commands that return immediately without concierge/agent. */
export const TAU_SYNC_COMMANDS = ['status', 'help', 'notify', 'unnotify'] as const

export type TauSyncCommand = (typeof TAU_SYNC_COMMANDS)[number]

export function isTauSlashCommand(cmd: string): cmd is TauSlashCommand {
  return (TAU_SLASH_COMMANDS as readonly string[]).includes(cmd)
}

export function isTauSyncCommand(cmd: string): cmd is TauSyncCommand {
  return (TAU_SYNC_COMMANDS as readonly string[]).includes(cmd)
}
