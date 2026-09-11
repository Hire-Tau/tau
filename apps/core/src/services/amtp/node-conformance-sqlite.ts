import { Database } from 'bun:sqlite'
import { join } from 'node:path'

/**
 * Opens the real node fixture database with the same connection-local safety
 * settings as amtp-node. Node initialization remains the sole migration owner.
 */
export function openNodeConformanceDb(home: string, options: { readonly?: boolean } = {}): Database {
  const sqlite = new Database(join(home, 'amtp.db'), options.readonly ? { readonly: true } : { create: true })
  try {
    sqlite.exec('PRAGMA journal_mode = WAL;')
    sqlite.exec('PRAGMA synchronous = FULL;')
    sqlite.exec('PRAGMA busy_timeout = 5000;')
    sqlite.exec('PRAGMA foreign_keys = ON;')
    return sqlite
  } catch (error) {
    sqlite.close()
    throw error
  }
}
