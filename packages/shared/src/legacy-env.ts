/**
 * Env-prefix rename (Tau → Ficus): `TAU_*` → `FICUS_*`.
 *
 * Host env files are hard-renamed with backups by the upgrade toolkit (and by
 * `renameEnvPrefix` for local installs). `bridgeLegacyEnv` is the one-release
 * in-process fallback for env the toolkit never rewrites (docker-compose
 * self-hosters, a local install self-updated by the old updater, user shells).
 * It ends in Wave 3, when `stripLegacyEnv` replaces it.
 *
 * Nothing here ever logs or throws a value: messages and results carry names only.
 */

export const LEGACY_ENV_PREFIX = 'TAU_'
export const ENV_PREFIX = 'FICUS_'
export type EnvPrefix = 'TAU_' | 'FICUS_'

export interface LegacyEnvBridgeResult {
  moved: string[]
  shadowed: string[]
  conflicts: string[]
}

const MANAGED_SECRET_KEYS_SUFFIX = 'MANAGED_SECRET_KEYS'

/** v2.1 (Ruling 24, N-I2): suffixes whose conflicting values must never be resolved silently. */
export function isProtectedEnvSuffix(suffix: string): boolean {
  return /ENCRYPTION_KEY|PASSWORD/.test(suffix)
}

/** A conflicting value for an encryption key keeps the legacy value: the secret store was encrypted with it. */
function keepsLegacyValue(suffix: string): boolean {
  return /ENCRYPTION_KEY/.test(suffix)
}

function isManagedSecretKeys(suffix: string): boolean {
  return suffix === MANAGED_SECRET_KEYS_SUFFIX || suffix.endsWith(`_${MANAGED_SECRET_KEYS_SUFFIX}`)
}

function otherPrefix(prefix: EnvPrefix): EnvPrefix {
  return prefix === LEGACY_ENV_PREFIX ? ENV_PREFIX : LEGACY_ENV_PREFIX
}

/** Legacy names are `TAU_` followed by at least one character. */
function legacySuffix(key: string): string | null {
  return key.startsWith(LEGACY_ENV_PREFIX) && key.length > LEGACY_ENV_PREFIX.length
    ? key.slice(LEGACY_ENV_PREFIX.length)
    : null
}

export class EnvPrefixConflictError extends Error {
  readonly keys: string[]

  constructor(keys: string[]) {
    super(
      `${keys.join(', ')}: the ${LEGACY_ENV_PREFIX} and ${ENV_PREFIX} names hold different values; ` +
        'keep the right one, remove the wrong value, then re-run'
    )
    this.name = 'EnvPrefixConflictError'
    this.keys = keys
  }
}

/** Map comma-separated env names in a *_MANAGED_SECRET_KEYS value to the target prefix. */
export function mapManagedKeyList(value: string, to: EnvPrefix): string {
  const from = otherPrefix(to)
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith(from) ? `${to}${item.slice(from.length)}` : item))
    .join(',')
}

/**
 * One release only. For each TAU_X: if FICUS_X is unset, set FICUS_X to its value (moved);
 * otherwise leave FICUS_X (shadowed). Always delete TAU_X. For keys ending in _MANAGED_SECRET_KEYS,
 * the moved value's comma-separated items are mapped TAU_→FICUS_. Never throws.
 * Protected conflict (FICUS_X set, different value, X protected): TAU_X is listed in `conflicts`; for
 * *ENCRYPTION_KEY* the TAU_ value is KEPT (FICUS_X is overwritten with it), because that is the key
 * the existing secret store was encrypted with. Identical values are a silent `shadowed`.
 */
export function bridgeLegacyEnv(env: Record<string, string | undefined>): LegacyEnvBridgeResult {
  const result: LegacyEnvBridgeResult = { moved: [], shadowed: [], conflicts: [] }
  for (const key of Object.keys(env)) {
    try {
      const suffix = legacySuffix(key)
      if (suffix === null) continue
      const legacyValue = env[key]
      const target = `${ENV_PREFIX}${suffix}`
      const current = env[target]
      if (legacyValue !== undefined) {
        if (current === undefined) {
          env[target] = isManagedSecretKeys(suffix) ? mapManagedKeyList(legacyValue, ENV_PREFIX) : legacyValue
          result.moved.push(key)
        } else {
          result.shadowed.push(key)
          if (current !== legacyValue && isProtectedEnvSuffix(suffix)) {
            result.conflicts.push(key)
            if (keepsLegacyValue(suffix)) env[target] = legacyValue
          }
        }
      }
      delete env[key]
    } catch {
      // Never throws: an unwritable env entry is left as it is.
    }
  }
  return result
}

/** Wave 3 replacement (Task 36): delete every TAU_X, return the names. Never throws. */
export function stripLegacyEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = []
  for (const key of Object.keys(env)) {
    if (legacySuffix(key) === null) continue
    try {
      delete env[key]
      removed.push(key)
    } catch {
      // Never throws.
    }
  }
  return removed
}

interface EnvLine {
  /** Everything before the key: indentation and an optional `export `. */
  lead: string
  key: string
  /** The raw text after `=`. */
  value: string
}

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function parseEnvLine(line: string): EnvLine | null {
  const match = ENV_LINE.exec(line)
  return match ? { lead: match[1], key: match[2], value: match[3] } : null
}

/** The value as a dotenv reader sees it, for comparing two lines: trimmed, one level of matching quotes removed. */
function normalizedValue(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote)) return value.slice(1, -1)
  }
  return value
}

/**
 * Pure hard rename of a dotenv file: every `KEY=` / `export KEY=` line whose key starts with `from`
 * becomes `to`. If a `to` line for the same suffix already exists, the `to` line wins and the `from`
 * line is dropped (listed in `conflicts`); identical values are dropped silently. v2.1: a protected
 * suffix (isProtectedEnvSuffix) with DIFFERENT values throws EnvPrefixConflictError before returning
 * anything (Ruling 24). *_MANAGED_SECRET_KEYS values are mapped. Comments, blank lines and
 * order are preserved. Idempotent.
 */
export function renameEnvPrefix(
  content: string,
  from: EnvPrefix,
  to: EnvPrefix
): { content: string; renamed: string[]; conflicts: string[] } {
  const lines = content.split('\n')
  const parsed = lines.map(parseEnvLine)

  // Existing `to` lines, by suffix. When a key repeats, dotenv keeps the last one.
  const targetValues = new Map<string, string>()
  for (const entry of parsed) {
    if (entry && entry.key.startsWith(to) && entry.key.length > to.length) {
      targetValues.set(entry.key.slice(to.length), normalizedValue(entry.value))
    }
  }

  const protectedConflicts: string[] = []
  for (const entry of parsed) {
    if (!entry || !entry.key.startsWith(from) || entry.key.length <= from.length) continue
    const suffix = entry.key.slice(from.length)
    const target = targetValues.get(suffix)
    if (target !== undefined && target !== normalizedValue(entry.value) && isProtectedEnvSuffix(suffix)) {
      if (!protectedConflicts.includes(entry.key)) protectedConflicts.push(entry.key)
    }
  }
  if (protectedConflicts.length > 0) throw new EnvPrefixConflictError(protectedConflicts)

  const renamed: string[] = []
  const conflicts: string[] = []
  const out: string[] = []
  lines.forEach((line, index) => {
    const entry = parsed[index]
    if (!entry || !entry.key.startsWith(from) || entry.key.length <= from.length) {
      out.push(line)
      return
    }
    const suffix = entry.key.slice(from.length)
    const target = targetValues.get(suffix)
    if (target !== undefined) {
      // The `to` line wins; this line is dropped.
      if (target !== normalizedValue(entry.value)) conflicts.push(entry.key)
      return
    }
    const value = isManagedSecretKeys(suffix) ? mapManagedKeyValue(entry.value, to) : entry.value
    out.push(`${entry.lead}${to}${suffix}=${value}`)
    renamed.push(entry.key)
  })

  return { content: out.join('\n'), renamed, conflicts }
}

/** Map a raw dotenv value, keeping its surrounding quotes. */
function mapManagedKeyValue(raw: string, to: EnvPrefix): string {
  const value = raw.trim()
  const quote = value[0]
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return `${quote}${mapManagedKeyList(value.slice(1, -1), to)}${quote}`
  }
  return mapManagedKeyList(value, to)
}

/** User-app env we hand to hosted apps: env plus TAU_ aliases for listed FICUS_ keys (one release). */
export function withLegacyAppAliases(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { ...env }
  for (const key of keys) {
    if (!key.startsWith(ENV_PREFIX) || key.length <= ENV_PREFIX.length) continue
    const value = env[key]
    if (value === undefined) continue
    out[`${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}`] = value
  }
  return out
}
