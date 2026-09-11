/**
 * Fixed kickoff-message templates for the guided first-squad step (design §4).
 *
 * Pure and side-effect free: the result is sent as a chat MESSAGE via the
 * existing chat-send API, never persisted to the squad's `context` field
 * (which is standing instructions, not a one-time kickoff — plan Task 3 /
 * spec §4's explicit "not the context field" rule).
 *
 * Repo URLs are used verbatim (surrounding whitespace only is trimmed); no
 * de-duplication is performed, so callers that want de-duped input must do
 * it themselves before calling this.
 */
export function composeKickoff(repos: string[]): string {
  if (repos.length === 0) {
    return [
      'Welcome aboard — no repositories were provided yet, so there is nothing to explore just yet.',
      '',
      'Please introduce yourself: summarize what this squad is for and what kinds of tasks you can help with.',
    ].join('\n')
  }

  const plural = repos.length > 1
  const repoList = repos.map((url) => `- ${url.trim()}`).join('\n')

  return [
    `Clone the following repositor${plural ? 'ies' : 'y'} into your workspace and explore ${plural ? 'their' : 'its'} layout:`,
    '',
    repoList,
    '',
    'Once you have a feel for the codebase, reply with a short summary of what you found and a few suggested first tasks.',
  ].join('\n')
}
