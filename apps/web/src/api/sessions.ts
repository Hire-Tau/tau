// Thin shim over @tau/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { SessionSummary } from '@tau/client-core'

export const listSessions = client.sessions.listSessions
export const revokeSession = client.sessions.revokeSession
export const revokeAllSessions = client.sessions.revokeAllSessions
