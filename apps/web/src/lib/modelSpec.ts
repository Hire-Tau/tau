export function isCodexModelSpec(modelSpec: string | null | undefined): boolean {
  const normalized = modelSpec?.trim().toLowerCase()
  return (
    normalized === 'openai-codex' ||
    normalized?.startsWith('openai-codex:') ||
    normalized?.startsWith('openai-codex/') ||
    false
  )
}
