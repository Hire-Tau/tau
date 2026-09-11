/** Provider credentials that can make OpenRouter test-chain candidates route-ready. */
const OPENROUTER_TEST_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'PROVIDER_AUTH_DATA',
  'XIAOMI_API_KEY',
  'ZAI_API_KEY',
] as const

export type ProviderAuthEnvSnapshot = Map<string, string>

/** Remove ambient provider auth while retaining enough state to restore it exactly. */
export function snapshotAndClearProviderAuthEnv(): ProviderAuthEnvSnapshot {
  const snapshot: ProviderAuthEnvSnapshot = new Map()
  for (const key of OPENROUTER_TEST_PROVIDER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) snapshot.set(key, value)
    delete process.env[key]
  }
  return snapshot
}

/** Restore provider auth after a hermetic test, including deleting newly leaked values. */
export function restoreProviderAuthEnv(snapshot: ProviderAuthEnvSnapshot): void {
  for (const key of OPENROUTER_TEST_PROVIDER_ENV_KEYS) {
    const value = snapshot.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
