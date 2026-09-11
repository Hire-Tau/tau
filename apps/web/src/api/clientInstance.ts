import { createClient } from '@tau/client-core'
import { webTransport } from './transport'

/** Singleton Tau API client bound to the web (cookie) transport. */
export const client = createClient(webTransport)
