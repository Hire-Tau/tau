// Thin shim over @tau/client-core (see ./clientInstance).
import { client } from './clientInstance'

export const listPendingActions = client.actions.listPendingActions
