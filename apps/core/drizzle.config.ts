import path from 'path'
import dotenv from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { resolveDatabaseTls } from './src/db/tls'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

/**
 * Migrations are a SECOND connection path: `bun run db:migrate` builds its
 * client inside drizzle-kit, not through createPostgresConnection. That is
 * precisely how the TLS bug fixed in 4f673b7f stayed hidden — migrations kept
 * succeeding while every runtime connection was refused — so the two paths
 * have to resolve TLS the same way, from the same module.
 *
 * Two concrete reasons this cannot just pass `url` through:
 *   * drizzle-kit hands `url` verbatim to postgres.js, which forwards the
 *     unrecognised `sslrootcert` parameter to the server and gets
 *     `FATAL: unrecognized configuration parameter "sslrootcert"`;
 *   * drizzle-kit's `{ url }` credential shape has no place for an `ssl`
 *     option at all, so with a url the CA could never be applied and
 *     verify-full would fail against a private CA like DigitalOcean's.
 * Its OTHER accepted shape — discrete host/port/user/password/database plus
 * `ssl` — supports both, so we switch to that, but ONLY when a CA is actually
 * configured. With no CA the url form is kept byte-for-byte as before, so
 * local dev and CI are untouched.
 */
function dbCredentials() {
  const raw = process.env.DATABASE_URL
  if (!raw) return { url: raw! }

  const { connectionString, ca } = resolveDatabaseTls(raw)
  if (!ca) return { url: connectionString }

  const url = new URL(connectionString)
  const password = decodeURIComponent(url.password)
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    ...(password ? { password } : {}),
    database: url.pathname.slice(1),
    ssl: { ca },
  }
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: dbCredentials(),
  // Filter out extension tables (PostGIS spatial_ref_sys, etc.)
  extensionsFilters: ['postgis'],
  // Exclude PostGIS tables from schema operations
  tablesFilter: ['!spatial_ref_sys', '!geometry_columns', '!geography_columns'],
})
