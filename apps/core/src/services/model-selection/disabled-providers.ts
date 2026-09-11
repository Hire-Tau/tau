import { getSettingsStore } from '../settings'

/**
 * Disabled-providers state for model fallback selection.
 *
 * Stored as a JSON array of provider ids under the `DISABLED_PROVIDERS` key in
 * the non-secret settings table. This decouples the enabled/disabled flag from
 * credentials: disabling a provider never deletes its stored key/OAuth token,
 * and re-enabling reuses the existing credential. Default = enabled (absence
 * from the array).
 *
 * Note: the settings store cache refreshes every ~60s in worker processes, so
 * a just-toggled flag can take up to ~60s to affect new sessions. Acceptable
 * per the design.
 */
const DISABLED_PROVIDERS_KEY = 'DISABLED_PROVIDERS'

function readDisabledArray(): string[] {
  const raw = getSettingsStore().get(DISABLED_PROVIDERS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** The set of currently disabled provider ids. */
export function getDisabledProviders(): Set<string> {
  return new Set(readDisabledArray())
}

/** Whether a provider is globally disabled (skipped by fallback selection). */
export function isProviderDisabled(provider: string): boolean {
  return getDisabledProviders().has(provider)
}

/**
 * Enable or disable a provider globally. Disabling does NOT delete
 * credentials; re-enabling reuses them.
 */
export async function setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
  const current = readDisabledArray()
  const set = new Set(current)
  if (enabled) {
    set.delete(provider)
  } else {
    set.add(provider)
  }
  const next = Array.from(set)
  const json = JSON.stringify(next)
  await getSettingsStore().set(DISABLED_PROVIDERS_KEY, json, 'admin')
}
