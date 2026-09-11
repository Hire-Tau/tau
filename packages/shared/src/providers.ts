/**
 * Provider label helpers shared across core and web.
 *
 * Maps a raw provider id (e.g. "zai", "openai-codex", "huggingface") to a
 * human-readable display name. Used by the provider-auth catalog route and the
 * agent conversation Info panel so labels stay consistent.
 */

/**
 * Explicit overrides for provider ids whose title-cased form would be wrong or
 * awkward (e.g. "zai" -> "Zai", "openai-codex" -> "Openai Codex").
 */
export const PROVIDER_LABEL_OVERRIDES: Record<string, string> = {
  zai: 'Z.ai',
  'zai-coding-cn': 'Z.ai Coding (CN)',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  huggingface: 'Hugging Face',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI (CN)',
  'amazon-bedrock': 'Amazon Bedrock',
  'azure-openai-responses': 'Azure OpenAI',
  'google-vertex': 'Google Vertex AI',
  'github-copilot': 'GitHub Copilot',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  nvidia: 'NVIDIA',
}

/** Human-friendly label for a provider id, e.g. "openrouter" -> "OpenRouter". */
export function providerLabel(id: string): string {
  if (PROVIDER_LABEL_OVERRIDES[id]) return PROVIDER_LABEL_OVERRIDES[id]
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
